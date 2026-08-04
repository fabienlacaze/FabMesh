-- ============================================================================
-- Octroi des credits AU MOMENT de la confirmation de l'e-mail
--
-- Complement INDISPENSABLE de la migration precedente. Sans lui, un
-- utilisateur qui s'inscrit puis confirme par courriel obtenait 0 credit et
-- ne les recevait JAMAIS : on aurait ferme la porte aux abus en la fermant
-- aussi aux clients legitimes.
--
-- `free_granted` garantit l'unicite : le declencheur ne peut pas recrediter
-- un compte a chaque mise a jour ulterieure de `auth.users` (changement de
-- mot de passe, nouvelle connexion, etc.).
-- ============================================================================

create or replace function public.handle_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.profiles
       set credits = credits + 15,
           free_granted = true
     where id = new.id
       and free_granted = false;
  end if;
  return new;
end;
$function$;

drop trigger if exists on_email_confirmed on auth.users;

create trigger on_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  execute function public.handle_email_confirmed()
