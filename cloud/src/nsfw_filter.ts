/**
 * NSFW prompt pre-filter — Worker-side. Port verbatim of
 * `src/main/main.js:checkPromptSafety` so cloud-generated images
 * follow the same parental-control policy as the desktop app.
 *
 * Two layers:
 *  - NSFW_KEYWORDS: any single keyword match → block
 *  - NSFW_COMBOS: any (groupA × groupB) pair → block (catches
 *    "young child without clothes" that single keywords miss)
 *
 * The deeper AI text classifier (Falconsai/NSFW_text_classifier on
 * desktop) is NOT ported — it would require an extra ML inference
 * per Worker request which is overkill at our scale. Image-level
 * NSFW filtering (post-gen) still runs on Modal via `modal_app/_nsfw.py`.
 *
 * Toggle: set the `NSFW_FILTER_OFF` env var to "1" on the Worker to
 * disable (intended for dev/staging, NEVER in prod).
 */

const NSFW_KEYWORDS: string[] = [
  // Sexual / nudity
  'nude', 'naked', 'nsfw', 'porn', 'porno', 'pornograph', 'sex', 'sexual',
  'erotic', 'hentai', 'xxx', 'lewd', 'topless', 'bottomless', 'lingerie',
  'bikini', 'underwear', 'undress', 'strip', 'stripper', 'orgasm', 'orgasme',
  'fetish', 'bdsm', 'bondage', 'dominat', 'submissi', 'sadis', 'masoch',
  'prostitut', 'escort', 'brothel', 'genital', 'penis', 'vagina', 'breast',
  'nipple', 'buttock', 'anus', 'anal', 'oral sex', 'fellat', 'cunniling',
  'masturbat', 'ejaculat', 'cum shot', 'creampie', 'gangbang', 'threesome',
  'orgy', 'sextoy', 'dildo', 'vibrator', 'lolicon', 'shotacon', 'furry nsfw',
  'rule34', 'rule 34', 'ahegao', 'ecchi', 'yaoi', 'yuri',
  'nu', 'nue', 'nus', 'nues', 'sexe', 'sexuel', 'erotique', 'poitrine', 'seins',
  'bite', 'couille', 'couilles', 'queue', 'chatte', 'nichon', 'nichons',
  'enculer', 'baiser', 'foutre', 'salope', 'pute', 'putain',
  'sodomie', 'fellation', 'cunnilingus', 'orgasme', 'jouir',
  'dick', 'cock', 'pussy', 'ass', 'tits', 'boobs', 'cum', 'slut', 'whore',
  // Violence / gore
  'gore', 'gory', 'blood', 'bloody', 'bleed', 'murder', 'murderer',
  'kill', 'killer', 'killing', 'torture', 'torturer', 'dismember',
  'decapitate', 'decapitation', 'mutilat', 'eviscerat', 'disembowel',
  'cannibal', 'flesh', 'corpse', 'cadaver', 'dead body', 'death scene',
  'execution', 'hanging', 'strangul', 'suffocate', 'drown', 'stab',
  'slash', 'wound', 'injury', 'graphic violence', 'brutal', 'savage',
  'massacre', 'slaughter', 'carnage', 'bloodbath', 'snuff',
  'meurtre', 'tuer', 'mort', 'cadavre', 'sang', 'sanglant',
  'violence', 'violent', 'cruaut',
  // Children / minors
  'child abuse', 'pedophil', 'paedophil', 'underage', 'minor',
  'loli', 'shota', 'preteen', 'toddler abuse', 'infant abuse',
  'enfant', 'mineur',
  // Drugs
  'drug', 'drugs', 'cocaine', 'heroin', 'heroine', 'meth', 'methamphet',
  'crack', 'opium', 'fentanyl', 'overdose', 'inject drug', 'snort',
  'drogue', 'stupefi',
  // Terrorism / extremism
  'terrorist', 'terrorism', 'bomb', 'bombing', 'mass shooting', 'genocide',
  'ethnic cleansing', 'hate crime', 'white supremac', 'nazi', 'swastika',
  'isis', 'al qaeda', 'jihad', 'radicali', 'extremis',
  'attentat', 'terroris',
  // Self-harm / suicide
  'suicide', 'self-harm', 'self harm', 'cut myself', 'slit wrist',
  'hang myself', 'jump off',
  // Hate / discrimination
  'racial slur', 'nigger', 'faggot', 'retard', 'kike', 'spic',
  'chink', 'wetback', 'hate speech',
  // Weapons (contextual)
  'how to make bomb', 'how to make gun', 'weapon tutorial',
  'build explosive', 'poison recipe',
];

interface Combo { a: string[]; b: string[] }
const NSFW_COMBOS: Combo[] = [
  // Children + nudity/sexual
  { a: ['child', 'children', 'kid', 'kids', 'boy', 'girl', 'teen', 'teenager', 'young', 'infant', 'baby', 'toddler', 'minor', 'preteen', 'schoolgirl', 'schoolboy', 'enfant', 'fille', 'garcon', 'jeune', 'ado', 'adolescent', 'gamin', 'gamine', 'bebe'],
    b: ['without clothes', 'no clothes', 'unclothed', 'undressed', 'disrobed', 'bare', 'exposed', 'revealing', 'intimate', 'sensual', 'seductive', 'provocative', 'suggestive', 'sexy', 'hot', 'bath', 'shower', 'bedroom', 'bed', 'lingerie', 'underwear', 'panties', 'bra', 'bikini', 'swimsuit', 'diaper only', 'sans vetement', 'sans habit', 'deshabill', 'nu ', 'nue ', 'nus ', 'nues'] },
  // Anyone + extreme sexual
  { a: ['woman', 'man', 'person', 'girl', 'boy', 'female', 'male', 'lady', 'femme', 'homme'],
    b: ['without clothes', 'no clothes', 'unclothed', 'fully exposed', 'spread legs', 'bent over', 'on knees', 'tied up', 'chained', 'whipped', 'spanked'] },
  // Violence + children
  { a: ['child', 'children', 'kid', 'kids', 'baby', 'infant', 'toddler', 'enfant', 'bebe'],
    b: ['hurt', 'hit', 'beat', 'punch', 'slap', 'abuse', 'attack', 'weapon', 'knife', 'gun', 'shoot', 'bleed', 'cry', 'scream', 'pain', 'suffer', 'frapper', 'battre', 'blesser'] },
];

function _matchesKeyword(text: string, kw: string): boolean {
  if (kw.length <= 4) {
    const padded = ' ' + text + ' ';
    return padded.includes(' ' + kw + ' ') || padded.includes(' ' + kw + ',') ||
           padded.includes(' ' + kw + '.') || padded.includes(' ' + kw + '!') ||
           padded.includes(' ' + kw + '?') || text.startsWith(kw + ' ') ||
           text.endsWith(' ' + kw);
  }
  return text.includes(kw);
}

export interface PromptSafetyResult {
  safe: boolean;
  blocked?: string;
  reason?: string;
}

export function checkPromptSafety(
  prompt: string | null | undefined,
  unrestricted = false,
): PromptSafetyResult {
  if (unrestricted) return { safe: true };
  const lower = (prompt || '').toLowerCase();
  for (const kw of NSFW_KEYWORDS) {
    if (_matchesKeyword(lower, kw)) {
      return { safe: false, blocked: kw,
        reason: `Content filter: "${kw}" is blocked. Modify your prompt or contact support to request unrestricted access.` };
    }
  }
  for (const combo of NSFW_COMBOS) {
    const hitA = combo.a.find(w => _matchesKeyword(lower, w));
    const hitB = combo.b.find(w => _matchesKeyword(lower, w));
    if (hitA && hitB) {
      return { safe: false, blocked: `${hitA} + ${hitB}`,
        reason: `Content filter: combination "${hitA}" + "${hitB}" is blocked. This type of content is not allowed.` };
    }
  }
  return { safe: true };
}
