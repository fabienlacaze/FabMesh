# MyFabmesh.AI Cloud — branded email templates

Drop-in HTML templates for Supabase Auth → Email Templates.
Dark theme matching the Cloud workspace: gradient pink → purple,
Ayros Studio footer, mobile-safe `<table>` layout.

## How to install — automated

```
node cloud/scripts/supabase-apply-email-templates.mjs
```

The script reads a Supabase PAT from either:
- env var `SUPABASE_PAT`, or
- `build/supabase-pat.txt` (gitignored — paste an `sbp_...` token there)

Then it PATCHes the project's Auth config with all 4 HTML bodies + subjects
in one API call. Safe to re-run.

## Mapping (for reference)

| Supabase template name | File in this folder |
|---|---|
| Confirm signup | `confirm-signup.html` |
| Magic Link | `magic-link.html` |
| Change Email Address | `change-email.html` |
| Reset Password | `reset-password.html` |

Subjects pushed by the script:
- Confirm signup → `Welcome to MyFabmesh.AI — confirm your account`
- Magic Link → `Your MyFabmesh.AI sign-in link`
- Reset Password → `Reset your MyFabmesh.AI password`
- Change Email → `Confirm your new MyFabmesh.AI email`

## Manual fallback (if the API ever breaks)

Dashboard URL:
https://supabase.com/dashboard/project/ovoccoipeqmkfnugkmyh/auth/templates

For each of the 4 message types, click the type in the left sidebar,
paste the matching HTML into the **Message body (HTML)** field, save.

## Variables used

These are Supabase Auth template variables — they get filled in
automatically at send time:

- `{{ .ConfirmationURL }}` — the action link (already includes the token)
- `{{ .Email }}` — current user email
- `{{ .NewEmail }}` — new email (only for change-email)

Do not URL-encode them — Supabase handles that.

## When we get a real domain

Once `myfabmesh.ai` is bought and DNS-verified in Resend, swap the
SMTP `Sender email` from `onboarding@resend.dev` to `noreply@myfabmesh.ai`
and update the footer URL in each template if you want.
