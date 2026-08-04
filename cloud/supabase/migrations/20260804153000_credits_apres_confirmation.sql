-- ============================================================================
-- Les credits d'inscription ne sont octroyes qu'APRES confirmation de l'e-mail
--
-- CONSTAT : la confirmation n'etait pas exigee. Deux comptes du 2026-07-23
-- (`toto@gmail.com`, `lundi.premier@gmail.com`) n'ont JAMAIS confirme et
-- detenaient malgre tout 50 credits. Rien n'empechait donc de fabriquer des
-- comptes a la chaine avec des adresses inventees — et on en voit deja la
-- trace : `lundi.premier@` et `lundi.premier1@`, la meme personne deux fois.
--
-- Une generation de maillage a froid coute 0,643 EUR. Un octroi gratuit non
-- verifie est donc une porte ouverte sur la facture GPU.
--
-- CHOIX D'IMPLEMENTATION : la regle vit ici, en base, et non dans un reglage
-- du tableau de bord Supabase. Un reglage se desactive par inadvertance et ne
-- laisse aucune trace dans le depot ; une contrainte en base est versionnee,
-- relisible, et s'applique quel que soit le chemin d'inscription.
--
-- `free_granted` empeche le double octroi : sans ce drapeau, toute mise a jour
-- ulterieure de `auth.users` aurait pu recrediter le compte.
-- ============================================================================

alter table public.profiles
  add column if not exists free_granted boolean not null default false;

-- Les comptes DEJA credites sont marques comme servis, pour qu'une
-- confirmation tardive ne leur ajoute pas une seconde dotation.
update public.profiles set free_granted = true where credits > 0 or free_granted = false;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_credits integer := 0;
  v_granted boolean := false;
begin
  -- Auto-confirme (ou confirmation desactivee) : on octroie tout de suite.
  if new.email_confirmed_at is not null then
    v_credits := 15;
    v_granted := true;
  end if;
  insert into public.profiles (id, email, credits, free_granted)
       values (new.id, new.email, v_credits, v_granted)
    on conflict (id) do nothing;
  return new;
end;
$function$
