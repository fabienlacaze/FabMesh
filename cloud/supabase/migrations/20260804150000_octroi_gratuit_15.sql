-- ============================================================================
-- Octroi d'inscription : 50 -> 15 credits
--
-- POURQUOI, chiffres a l'appui (mesures du 2026-08-04) :
-- Une generation de maillage A FROID coute 0,643 EUR tout compris, et au
-- lancement TOUTES les generations sont froides puisque le trafic est faible.
-- Aux tarifs releves le meme jour (maillage = 8 a 16 credits), 50 credits
-- offerts representaient jusqu'a 6 maillages, soit **3,86 EUR de cout reel
-- pour 0 EUR encaisse** a chaque inscription.
--
-- Or une conversion Starter ne rapporte que +3,07 EUR net de frais Stripe :
-- UN SEUL compte gratuit qui consomme tout coute plus cher qu'une vente
-- Starter ne rapporte. Il aurait fallu convertir 33 % des inscrits en Pro,
-- ou 14 % en Studio, quand le taux gratuit->payant usuel est de 2 a 5 %.
--
-- 15 credits = 1 maillage + quelques images : assez pour voir la valeur du
-- produit, pas assez pour satisfaire le besoin. Cout par inscrit ramene a
-- ~1 EUR.
--
-- LES COMPTES EXISTANTS NE SONT PAS TOUCHES. Reprendre des credits deja
-- octroyes serait une rupture de parole envers des gens qui n'ont rien
-- demande — et le volume en jeu (6 comptes intacts) ne le justifie pas.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email, credits) values (new.id, new.email, 15)
    on conflict (id) do nothing;
  return new;
end;
$function$
