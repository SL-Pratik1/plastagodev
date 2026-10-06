# ClickSend SMS Setup — Instructions for PlastaGo

**Purpose:** allow the PlastaGo platform to send text messages — the sign-in codes that drivers and site supervisors use to get into the app, and the job notices sent to people who have given a mobile number.

**Audience:** whoever manages PlastaGo's ClickSend account and billing. No technical background needed.

**Time required:** about 15 minutes, plus a wait for approval in section 3 if you choose a sender name.

**Cost:** a few cents per message. Section 6 explains what a normal month looks like.

**What we need back:** two values and one decision. Section 5 has the exact list.

---

## 0. Before you start

**The account must have credit.** This is the single most important point in this document, so it is said first. The account currently shows a **$0.00** balance. Until money is added, every text message silently fails.

**A card is required**, the same as any prepaid service. ClickSend is pay-as-you-go — there is no monthly fee and no contract.

**Use the company ClickSend account, not a personal one.** PlastaGo keeps ownership of the account and the billing, and can revoke our access at any time. We only ever receive the two values in section 5 — we never get your login password.

---

## 1. What this is for, and what it is not

Text messaging is not a "nice to have" on this platform. It is how two groups of people get in at all.

| Who | What the text does | What happens without it |
|---|---|---|
| **Drivers** | Sends the code they type to sign in | The driver cannot start their run |
| **Site supervisors** | Sends the code they type to sign in | The supervisor cannot see their job |
| **Customers with a mobile on file** | Job updates, such as a run date change | They only get the email |

Drivers and site supervisors are people working on building sites. They do not have company email addresses and will not remember a password, so the platform deliberately signs them in by text instead. That makes a messaging failure a failure to let somebody start work — not a missed notification.

**Not requested:** access to your contacts, your email, or any customer data held in ClickSend. The platform only ever sends one message at a time to one number. It never reads anything back.

---

## 2. Add credit

This is step one, and nothing works before it.

1. Sign in at <https://dashboard.clicksend.com>.

2. At the top of the page, next to **Balance**, click the **+** button.

3. Add an amount. **$20–$50 is a sensible start** — it is enough to test properly and then carry straight into normal use.

---

## 3. Choose the sender name — a decision we need from you

When the text arrives on someone's phone, it shows a sender. You have two choices, and this one is yours to make, not ours.

| | Option A — a name | Option B — a phone number |
|---|---|---|
| **Shows as** | `PlastaGo` | `+61 4XX XXX XXX` |
| **Looks** | More professional | Like an unknown number |
| **Can the person reply?** | **No** | Yes |
| **Cost** | Free | A small monthly fee for the number |
| **Ready when?** | After approval — allow a day or two | Immediately |

**Our recommendation is Option A, `PlastaGo`.** None of the messages the platform sends ask for a reply, so the inability to reply costs nothing. Where a reply would be useful, the message puts a phone number in the text itself for the person to call.

Choose Option B if you would rather customers were able to text back, and are willing to have somebody watching that inbox.

### To set up Option A — the name

1. In the left-hand menu, click **Sender IDs**.
2. Add a new alphanumeric sender ID: **`PlastaGo`**.
3. Submit it for approval and wait for ClickSend to confirm.

> **Do not skip the approval.** An unapproved name behaves exactly like an empty balance — the message is accepted and then quietly not delivered. Please tell us once it is approved, not when it is submitted.

### To set up Option B — the number

1. In the left-hand menu, find **Numbers**.
2. Buy a dedicated Australian mobile number.
3. Send us the number, written as `+61412345678`.

---

## 4. Get the API credentials

1. In the left-hand menu, click **Developers**, then **API Credentials**.

2. The page shows your **username** and your **API key**. Copy both.

### ⚠️ The API key is not your password

This catches people out. The API key is a long string of random characters that ClickSend generated for you. It is **not** the password you typed to log in to the dashboard.

If the password is sent instead, every message is refused and the symptom looks identical to every other failure in this document. If you are unsure which value you are looking at, send us a screenshot of the page with the key itself blanked out, and we will confirm you are in the right place.

---

## 5. What to send back

Three things.

```
1. ClickSend username:    ________________________

2. ClickSend API key:     ________________________
                          (from Developers → API Credentials — not your password)

3. Sender choice:         Option A, the name "PlastaGo"
                          or
                          Option B, the number +61____________

4. Also confirm:          Credit added?        yes / no
                          Sender ID approved?  yes / no / not applicable
```

---

## 6. What this should cost

Australian text messages are a few cents each. ClickSend charges less per message as monthly volume rises, and publishes current rates at <https://www.clicksend.com/au/pricing/>.

To estimate your own bill, the things that generate a message are:

- **One message each time a driver signs in.** Drivers sign in roughly once per shift, not once per job.
- **One message each time a site supervisor signs in.** Less often — only when they check a job.
- **Occasional job notices**, and only to customers who have given a mobile number and have not opted out. Everyone else receives email, which costs nothing.

A long message counts as more than one. The platform keeps its messages short for exactly this reason.

If you want a firm number before committing, add $20, run for a fortnight, and read the usage from the dashboard. That is a more honest estimate than any figure we could calculate in advance.

---

## 7. What happens after you send the details

On our side it is a five-minute job — the software has been built and tested against ClickSend already, and nothing needs writing. The steps are:

1. We check your username and key are valid. This costs nothing and sends no message.
2. We switch the platform from its offline mode to live ClickSend.
3. We send one real test message to a phone you nominate, and confirm with you that it arrived.

Until then the platform keeps running normally in offline mode. Nothing is broken and nothing is waiting — sign-in codes simply appear in our logs instead of on a phone, which is fine while the system is still being tested but is not something real drivers can use.
