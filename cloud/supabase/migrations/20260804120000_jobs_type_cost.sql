-- ============================================================================
-- jobs : deux vraies colonnes `type` et `cost_usd`
--
-- POURQUOI
-- La table servait a la fois les maillages et les ~28 types d'operations
-- journalises par `logOperation`, mais rien n'indiquait de quel type de
-- travail il s'agissait. `asset_type` ne pouvait pas jouer ce role : il est
-- POLYSEMIQUE — il vaut 'character' / 'vehicle' pour un maillage (le type
-- d'objet demande) et 'text2image' / 'remove-bg' pour une operation (le type
-- d'appel). Impossible d'en tirer un filtre fiable.
--
-- Consequence concrete, constatee le 2026-08-04 : on a conclu « aucune
-- activite depuis six jours » en interrogeant cette table, alors qu'un
-- testeur de certification Microsoft utilisait l'application et que la
-- facture Modal montait. Les generations d'IMAGES ne laissaient pas de
-- ligne exploitable.
--
-- `cost_usd` sort le cout du JSONB `options` pour en faire une colonne
-- indexable : les agregats du tableau de bord (par type, par jour, marge)
-- devaient jusqu'ici desagreger du JSON ligne par ligne.
--
-- REPRISE DES ANCIENNES LIGNES
-- `type`     : depuis options->>'operation_type' quand il existe ; sinon
--              'mesh' si l'identifiant commence par 'modal_' (convention des
--              jobs de maillage) ; sinon 'legacy' — on ne devine pas.
-- `cost_usd` : depuis options->>'cost_usd' quand il existe, laisse a NULL
--              sinon. SURTOUT PAS 0 : un cout inconnu ecrit a zero afficherait
--              une marge de 100 % et mentirait sur la rentabilite. NULL se
--              lit « non chiffre », et le tableau de bord sait deja distinguer
--              les lignes mesurees des lignes estimees.
--
-- Les deux colonnes sont NULLABLE : aucune ecriture existante ne casse, et
-- le worker peut ecrire en double (colonnes + `options`) le temps que les
-- lecteurs basculent.
-- ============================================================================

alter table public.jobs add column if not exists type     text;
alter table public.jobs add column if not exists cost_usd numeric(10, 6);

-- Reprise : type
update public.jobs
   set type = coalesce(
         nullif(options->>'operation_type', ''),
         case when id like 'modal\_%' then 'mesh' else 'legacy' end)
 where type is null;

-- Reprise : cout. On ne convertit que ce qui est reellement numerique —
-- une valeur illisible doit rester NULL plutot que de devenir 0.
update public.jobs
   set cost_usd = (options->>'cost_usd')::numeric
 where cost_usd is null
   and options->>'cost_usd' ~ '^[0-9]+(\.[0-9]+)?$';

-- Index sur les deux axes de lecture du tableau de bord : « par type » et
-- « par type sur une periode ».
create index if not exists jobs_type_idx         on public.jobs (type);
create index if not exists jobs_type_created_idx on public.jobs (type, created_at desc);
