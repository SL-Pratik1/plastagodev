# Microsoft 365 Email Setup — Instructions for Your IT Team

**Purpose:** allow the PlastaGo platform to send transactional email (order confirmations, purchase orders, notifications) from two of your mailboxes.

**Audience:** your Microsoft 365 / Entra ID administrator.

**Time required:** approximately 20–30 minutes.

**Cost:** nothing. Every step below uses features already included in your Microsoft 365 subscription. No new licences, no Azure subscription, and no add-ons are required.

---

## 0. Before you start

**Roles needed.** The steps below span two admin areas, so either one person holding both roles or two people working together:

| Steps | Role required |
|---|---|
| 2, 3, 4 | **Application Administrator** or **Cloud Application Administrator** (Global Administrator also works) |
| 5 | **Exchange Administrator** |

**Mailboxes must be in Exchange Online.** This method does not work for mailboxes still hosted on an on-premises Exchange server. If you run a hybrid setup, please confirm that `noreply@` and `po@` are cloud mailboxes, or let us know and we will discuss alternatives.

**PowerShell module.** Step 5 needs the Exchange Online management module. If it is not already installed:

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser
```

---

## 1. What we are asking for, and what we are not

We need app-only ("daemon") access to Microsoft Graph so our platform can send mail from two specific mailboxes without a signed-in user.

| | |
|---|---|
| **Mailboxes in scope** | `noreply@<your-domain>` and `po@<your-domain>` — only these two |
| **Access level** | Send mail from those two mailboxes |
| **Not requested** | Access to any other mailbox, user data, files, Teams, SharePoint, or directory data |
| **Not requested** | Tenant-wide `Mail.Send` consent (see the note in step 3 — we specifically do *not* want this) |

The setup below is scoped in Exchange Online, so the credential we receive is only ever able to reach those two mailboxes. You can revoke it at any time in one step (see section 7).

---

## 2. Create the two mailboxes

Skip this if `noreply@` and `po@` already exist.

1. Go to the **Microsoft 365 admin center** → **Teams & groups** → **Shared mailboxes**.
2. Create `noreply@<your-domain>` and `po@<your-domain>`.

**Shared mailboxes are free and require no licence**, so this adds nothing to your bill. Regular licensed mailboxes work equally well if you prefer.

---

## 3. Register the application

1. Go to the **Microsoft Entra admin center** (<https://entra.microsoft.com>) → **Applications** → **App registrations** → **New registration**.
2. Fill in:
   - **Name:** `PlastaGo Mail Integration`
   - **Supported account types:** *Accounts in this organizational directory only* (single tenant)
   - **Redirect URI:** leave blank — this is a background service using the client credentials flow.
3. Select **Register**.
4. From the app's **Overview** page, note down the **Application (client) ID** and the **Directory (tenant) ID**. You will send us these in section 6.

> **Important — please do not add API permissions.**
>
> Leave the **API permissions** section empty. Granting `Mail.Send` there applies it **tenant-wide**, which would let the application send mail as *every* mailbox in your organisation. We do not want that level of access.
>
> Instead, the next step grants send rights on the two named mailboxes only, using Exchange Online role-based access control.

---

## 4. Find the service principal Object ID

The next step needs the Object ID of the *service principal*, which is different from the Object ID shown on the App registrations page.

1. In the Entra admin center, go to **Applications** → **Enterprise applications**.
2. Search for `PlastaGo Mail Integration` and open it.
3. Copy the **Object ID** shown there.

You now have three values: the tenant ID, the client ID, and this service principal Object ID.

---

## 5. Scope access to the two mailboxes (RBAC for Applications)

This uses **RBAC for Applications**, which is Microsoft's current and supported method for limiting an application to specific mailboxes. It replaces the older Application Access Policy approach, which Microsoft has marked as legacy and will deprecate.

Run the following in **Exchange Online PowerShell**, signed in as an account holding the **Exchange Administrator** role. Replace the three placeholder values first.

```powershell
Connect-ExchangeOnline

# Register the app with Exchange Online.
# -ObjectId is the Enterprise applications Object ID from step 4,
# NOT the Object ID on the App registrations page.
$sp = New-ServicePrincipal `
        -AppId    "<APPLICATION_CLIENT_ID>" `
        -ObjectId "<ENTERPRISE_APP_OBJECT_ID>" `
        -DisplayName "PlastaGo Mail Integration"

# Define exactly which mailboxes the app may touch.
New-ManagementScope `
  -Name "PlastaGo Mailboxes" `
  -RecipientRestrictionFilter "EmailAddresses -eq 'noreply@<your-domain>' -or EmailAddresses -eq 'po@<your-domain>'"

# Grant send rights on that scope, and nothing else.
New-ManagementRoleAssignment `
  -App  $sp.AppId `
  -Role "Application Mail.Send" `
  -CustomResourceScope "PlastaGo Mailboxes"
```

**Verify it resolves correctly:**

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<APPLICATION_CLIENT_ID>" `
  -Resource "noreply@<your-domain>"
```

> **Please note:** RBAC changes can take up to about **one hour** to take effect on live Microsoft Graph API calls, even once the test command above reports success. If our first test send fails immediately after setup, this is usually why.

---

## 6. Create a credential and send it to us

Go to the app registration → **Certificates & secrets**.

**Option A — certificate (preferred).** Upload a certificate rather than using a shared secret. Certificates are the more secure option and typically have longer validity. Let us know if you would like to use this route and we will send you a certificate signing request.

**Option B — client secret.** Select **New client secret**, give it the description `PlastaGo Mail Integration` and the longest expiry your policy permits.

> Copy the secret **Value** immediately. Microsoft only displays it once; after you leave the page it cannot be retrieved and a new secret must be created.

> **Please record the expiry date and include it below.** When a client secret expires, email sending stops without warning. We will set our own reminder to request a replacement ahead of that date.

### Please send us the following

| Item | Value |
|---|---|
| Directory (tenant) ID | |
| Application (client) ID | |
| Sending mailbox 1 | `noreply@` ______________________ |
| Sending mailbox 2 | `po@` ______________________ |
| Client secret expiry date | |
| Client secret value | **Do not enter here — send separately, see below** |

**How to send the client secret:** please share it through a password manager link (1Password, Keeper, Bitwarden, LastPass or similar) or your organisation's approved secrets tool.

Please **do not** send the secret by email, chat, SMS, or in a document alongside the client ID. Anyone who obtains the secret together with the tenant and client IDs can send mail from those two mailboxes until it is revoked.

---

## 7. How to revoke access

Access can be withdrawn at any time, immediately, with no effect on any other part of your tenant:

- **To revoke the credential only:** delete the client secret or certificate from **Certificates & secrets**.
- **To revoke all access:** delete the app registration, or remove the role assignment:

  ```powershell
  # Find the assignment name first
  Get-ManagementRoleAssignment -Role "Application Mail.Send" | Format-List Name, App, CustomResourceScope

  # Then remove it
  Remove-ManagementRoleAssignment -Identity "<name from above>"
  ```

Nothing else in your Microsoft 365 configuration is modified by this setup.

---

## 8. Good to know

**Sending limits.** Exchange Online applies roughly 10,000 recipients per day and about 30 messages per minute per mailbox, and app-only sends count toward these limits. This is comfortably above our expected volume. We will let you know in advance if that changes.

**Deliverability.** Because mail will be sent from your domain, please make sure SPF, DKIM and DMARC are configured for it. This is standard Microsoft 365 configuration and most likely already in place.

**Auditing.** All sends made through this application are recorded in the Microsoft 365 unified audit log against the application's name, so activity remains fully traceable to this integration.

---

## Questions

If anything above is unclear, or if your security policy requires a different approach, please contact us before making changes and we will work through it with your team. We are happy to join a call and walk through it with your administrator.

**Contact:** `<your name>` — `<your email>`

---

*Prepared for `<client name>` · `<date>`*
