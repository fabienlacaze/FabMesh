# Microsoft Store Submission Automation

This guide walks you through the **one-time** setup so that
`scripts/submit_appx.ps1` can authenticate against the Microsoft Store
Submission API and ship new `.appx` builds without using the Partner
Center web UI.

Reference: <https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services>

---

## 1. Associate Partner Center with an Azure AD tenant

The Submission API authenticates via Azure Active Directory, so your
Partner Center account must be linked to an AAD tenant.

1. Sign in to <https://partner.microsoft.com/dashboard>.
2. Click the gear icon → **Account settings** → **Tenants**.
3. Click **Associate Azure AD tenant**.
4. If you do not have a tenant yet, click **Create a new Azure AD**
   from the same page — it is free.
5. Confirm the tenant association.

You only do this once per Partner Center account.

---

## 2. Register an Azure AD application

1. Open <https://portal.azure.com>.
2. Search bar → **Azure Active Directory** → **App registrations** →
   **+ New registration**.
3. **Name**: `MyFabmesh Store Publisher` (or anything descriptive).
4. **Supported account types**: *Accounts in this organizational
   directory only (single tenant)*.
5. **Redirect URI**: leave empty.
6. Click **Register**.

---

## 3. Generate a client secret

1. From the new app blade → **Certificates & secrets** → **+ New
   client secret**.
2. **Description**: `submit_appx.ps1`.
3. **Expires**: `24 months` (longest available).
4. Click **Add**.
5. **COPY THE VALUE COLUMN IMMEDIATELY.** Azure shows the secret value
   only once — close the blade and it's gone forever. If you lose it,
   delete the secret and create a new one.

---

## 4. Note the IDs

Go to the app's **Overview** page and copy:

- **Application (client) ID** → `MS_STORE_CLIENT_ID`
- **Directory (tenant) ID**   → `MS_STORE_TENANT_ID`

---

## 5. Add the AAD app as a Partner Center user

The AAD app itself must be a user of Partner Center with publish
rights.

1. Back to <https://partner.microsoft.com/dashboard>.
2. Gear icon → **Account settings** → **User management** → **Users**.
3. Click **+ Add user** → **Add Azure AD applications**.
4. Search for the app you just registered (`MyFabmesh Store
   Publisher`).
5. Assign role: **Manager**.

> **Important:** *Developer* and *Marketer* roles cannot publish
> submissions via the API — you will get HTTP 403. Use **Manager**.

---

## 6. Fill `.env`

At the repo root, copy the template and fill in the four values:

```powershell
Copy-Item .env.example .env
notepad .env
```

| Key                          | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| `MS_STORE_TENANT_ID`         | Directory (tenant) ID — step 4                     |
| `MS_STORE_CLIENT_ID`         | Application (client) ID — step 4                   |
| `MS_STORE_CLIENT_SECRET`     | Secret VALUE you copied — step 3                   |
| `MS_STORE_APPLICATION_ID`    | `9PH6GT8XKQDW` (already set, MyFabmesh Store ID)   |

The `.env` file is gitignored — never commit it. Only `.env.example`
ships in git.

---

## 7. Run the script

Once a new build is ready in `dist/installer/`:

```powershell
powershell -File scripts/submit_appx.ps1 -AppxPath "dist/installer/MyFabmesh.AI 1.0.1.appx"
```

Useful flags:

- `-DryRun` — fetch token + state, list what *would* be uploaded, but
  do not create or commit a submission. Use to validate credentials.
- `-EnvFile path/to/other.env` — override the default `.env` location.

The script will:

1. Validate the four env keys.
2. Get an OAuth token from `login.microsoftonline.com`.
3. Check for an in-progress submission and (with your confirmation)
   delete it.
4. Create a new submission, downloading the previous submission zip
   as the base.
5. Replace the `.appx` inside the zip with your new build.
6. Upload the zip to Azure Blob storage.
7. Commit the submission and poll its status.
8. Print the dashboard URL so you can monitor certification.

Microsoft certification typically takes 24–48 h; the script stops
polling once the submission has entered the **Certification** phase.

---

## Troubleshooting

| HTTP | Meaning                                                          | Fix                                                                                        |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 401  | OAuth token rejected.                                            | Re-check `MS_STORE_CLIENT_ID` / `MS_STORE_CLIENT_SECRET`. Regenerate the secret if needed. |
| 403  | Token is valid but the caller lacks Partner Center permission.   | Step 5: role must be **Manager**, not Developer/Marketer.                                  |
| 404  | App ID not found, or no previous submission to clone from.       | Verify `MS_STORE_APPLICATION_ID`. For a first-ever submission, push it manually once.      |
| 409  | A submission is already in progress.                             | The script detects this and offers to delete the pending one. Confirm with `y`.            |
| 5xx  | Microsoft-side transient error.                                  | Wait a few minutes and retry. Submission API is occasionally flaky.                        |

If `Invoke-RestMethod` hangs or TLS-errors immediately, you are
probably on stock PowerShell 5.1 with TLS 1.0 default — the script
already forces TLS 1.2 at startup, so update it from this repo rather
than running an old copy.

---

## See also

- Partner Center dashboard:
  <https://partner.microsoft.com/dashboard/products/9PH6GT8XKQDW/overview>
- Submission API reference:
  <https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services>
- `scripts/submit_appx.ps1` — the automation entry point.
- `.env.example` — credential template.
