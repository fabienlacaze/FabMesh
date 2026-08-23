-- Conservation comptable vs droit a l'effacement — 2026-08-23.
--
-- `handleDeleteAccount` anonymise les paiements (`user_id = null`) plutot que
-- de les supprimer : l'art. L102 B du livre des procedures fiscales impose de
-- conserver six ans les pieces justificatives de recettes, et l'art. 17.3.b du
-- RGPD reserve explicitement ce cas. Le code etait juste ; LE SCHEMA LE
-- RENDAIT INAPPLICABLE, de deux facons independantes :
--
--   1. `user_id` etait NOT NULL. L'UPDATE echouait en 23502, le code
--      retombait sur son repli `delete()`, et la preuve comptable
--      disparaissait a chaque suppression de compte. `anonymise_le` n'a donc
--      JAMAIS ete ecrite.
--   2. La cle etrangere etait ON DELETE CASCADE. Meme anonymisation reussie,
--      la suppression de l'utilisateur Supabase — faite juste apres par le
--      meme handler — aurait emporte la ligne. Les deux verrous devaient
--      sauter ensemble, sans quoi le correctif restait inerte.
--
-- La colonne `anonymise_le` manquait aussi de `sql/schema.sql` : tout
-- environnement reconstruit a partir du schema etait non conforme.

alter table public.payments alter column user_id drop not null;

alter table public.payments
  add column if not exists anonymise_le timestamptz;

comment on column public.payments.anonymise_le is
  'Date de deliaison du compte (droit a l''effacement). La ligne est conservee '
  'six ans au titre de l''art. L102 B LPF : montant, date et reference Stripe '
  'restent, l''identifiant utilisateur non.';

-- ON DELETE CASCADE -> ON DELETE SET NULL. Le nom de la contrainte est celui
-- que Postgres genere par defaut ; on le retrouve par le catalogue pour ne pas
-- dependre d'une convention.
do $$
declare
  nom text;
begin
  select conname into nom
    from pg_constraint
   where conrelid = 'public.payments'::regclass
     and contype  = 'f'
     and array_position(conkey, (
           select attnum from pg_attribute
            where attrelid = 'public.payments'::regclass and attname = 'user_id'
         )) is not null
   limit 1;
  if nom is not null then
    execute format('alter table public.payments drop constraint %I', nom);
  end if;
  alter table public.payments
    add constraint payments_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;
end $$;
