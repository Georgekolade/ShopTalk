# ShopTalk AI demo script

Prepare the demo business (existing `george` account, existing GeoPure
workspace). In the backend container terminal:

```sh
python manage.py seed_geopure --replace-legacy   # first time only
python manage.py seed_geopure                    # safe heal on reruns
```

Sign in as `george` (the seeder never resets the account password).

1. **The business.** Open Setup: GeoPure, NGN, opening hours 8am–8pm
   daily, delivery/pickup, cash and transfer, no returns — taught as
   verified rules and a knowledge document. Open Catalogue: only the
   three GeoPure Honey Beans packs (2.5kg ₦7,000, 5kg ₦14,000, 10kg
   ₦28,000). Open the Dashboard: 26 months of beans trading, with the
   price journey from ₦5,000 to ₦7,000 visible in report trends.
2. **Voice sale.** In the Assistant, tap Mic and say "sell 2 honey beans
   2.5kg". The transcript lands in the input, editable. Send it, then
   repeat the same request by typing to show voice/text parity.
3. **Clarification.** Say "sell 2 beans" or "sell 2 oil". Ambiguous or
   unknown items trigger a question; nothing is committed.
4. **Confirm.** A preview shows lines, server-side prices, and the
   ₦14,000 total. Press Confirm: the reply names the receipt number.
   Check Transactions (committed sale), Dashboard (figures moved),
   Activity (audit events), and stock (two packs gone).
5. **Second workflows.** Say "we received 20 honey beans 5kg" and
   confirm, or say "spent 4500 on delivery fuel" and confirm.
   Stock and expenses update.
6. **Grounded questions.** Ask "how much did we sell this month?",
   "what is running low?", and "what are your delivery and returns
   policies?" Sales and stock answers match the Dashboard; policy
   answers come from the seeded GeoPure knowledge document, and caveats
   name any data limits.

Everything shown is a live backend write. No mock data.

## Backup plan

If voice recognition fails in the demo browser, the recording fallback
transcribes with Muse Voice Transcribe; failing that, type the same
requests — both take the identical backend path. If the model provider
is down, the offline heuristic answers the scripted lines above. If the
network drops, the app shows "you are offline" instead of failing
silently; reconnect and continue. As a last resort, the Transactions
page performs the same sale, receipt, and expense flows through manual
forms.
