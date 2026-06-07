# Brancher Milo sur iMessage via LoopMessage (sandbox)

> La **sandbox** LoopMessage est gratuite, illimitée en messages, **5 contacts max**.
> ⚠️ Limite clé : la sandbox **ne peut pas initier** de conversation (fenêtre de 24h après le
> dernier message du contact). Le chat réactif marche ; la **proactivité** (rappels/veille/nudges)
> ne part que si le contact t'a écrit dans les dernières 24h. Pour une vraie proactivité gratuite,
> on basculera plus tard sur Telegram ou un Mac+BlueBubbles (canal abstrait, swap d'1 fichier).

## 1. Compte & clé d'API
1. Crée un compte sur **dashboard.loopmessage.com**.
2. Récupère ta **clé `Authorization`** (API key) → `.env` :
   ```
   LOOPMESSAGE_AUTH_KEY=<ta_clé_authorization>
   ```

## 2. Contacts sandbox (≤ 5)
- Chaque contact doit **d'abord écrire** à ton expéditeur sandbox (depuis son iPhone/Mac) pour
  ouvrir la fenêtre — ou utilise « Compose message in sandbox » depuis ton appareil.
- Le `sender` est **ignoré en sandbox** → laisse `LOOPMESSAGE_SENDER_NAME=` vide.

## 3. Webhook entrant
Dans le dashboard (réglages webhook de l'organisation) :
1. **URL** = ton URL publique + `/webhook` (voir ngrok ci-dessous).
2. **Authorization header** = une valeur secrète que tu choisis. Génère-la :
   ```bash
   openssl rand -hex 32
   ```
   Mets la **même** valeur dans `.env` :
   ```
   LOOPMESSAGE_WEBHOOK_SECRET=<la_même_valeur>
   ```
3. Active au moins l'event **`message_inbound`**.

## 4. Config Milo (`.env`)
```
MILO_CHANNEL=loopmessage
MILO_ALLOWLIST=+33XXXXXXXXX,+33YYYYYYYYY   # numéros E.164 de tes contacts sandbox
LOOPMESSAGE_AUTH_KEY=...
LOOPMESSAGE_WEBHOOK_SECRET=...
LOOPMESSAGE_SENDER_NAME=                    # vide en sandbox
```

## 5. Exposer le webhook (ngrok)
```bash
brew install ngrok            # si besoin
ngrok config add-authtoken <ton_token_ngrok>   # compte ngrok gratuit
ngrok http 3000
```
Copie l'URL `https://xxxx.ngrok-free.app` → mets `https://xxxx.ngrok-free.app/webhook` comme URL
de webhook dans le dashboard LoopMessage. (L'URL change à chaque redémarrage de ngrok en version
gratuite — pense à la remettre à jour, ou prends un domaine statique ngrok.)

## 6. Lancer & tester
```bash
docker compose up -d
npm run db:setup      # si pas déjà fait
npm run dev:web       # terminal 1
npm run dev:worker    # terminal 2
```
Depuis un **contact sandbox**, envoie un iMessage à ton expéditeur sandbox → Milo répond. 🎉

## Référence — API utilisée
- **Envoi** : `POST https://a.loopmessage.com/api/v1/message/send/`, header `Authorization: <clé>`,
  corps `{ "contact": "+33…", "text": "…", "sender": "…"(optionnel) }`.
- **Webhook entrant** : JSON `{ "event": "message_inbound", "contact": "+33…", "text": "…",
  "message_id": "…", "message_type": "text" }`, avec le header `Authorization` que tu as configuré.
