# Milo 🤖

Assistant IA personnel **proactif**, accessible directement dans **iMessage** — comme un pote à qui tu textes. Construit avec **Claude**, **TypeScript**, déployé sur **Railway**.

> Pensé pour toi + quelques proches (liste blanche). Inspiré de Poke.com.

## ✨ Fonctionnalités
- 💬 **Chat naturel** — répond comme un pote (ton texto, court, multi-bulles, zéro markdown)
- 🔎 **Recherche web** token-optimisée via **Exa** (réponse synthétisée + sources, ~10-50× moins de tokens que la recherche brute)
- 📧 **Gmail** — lire, chercher, résumer, **rédiger et envoyer** des mails (envoi confirmé d'un « ok »)
- 📅 **Agenda Google** — voir le programme, vérifier les dispos, créer des événements
- 🧹 **Triage email proactif** — un filtre d'inbox qui te texte spontanément ce qui compte vraiment
- 🔁 **Automations** — triggers récurrents ou déclenchés par un email, en langage naturel (« chaque lundi 8h, résume les mails de mon boss »)
- ☀️ **Brief quotidien** — agenda + mails importants + actus, à l'heure que tu choisis
- 🖼 **Multimodal** — comprend les images, PDF et notes vocales (transcription Whisper)
- 🧩 **Serveurs MCP** — branche n'importe quelle app (Notion, Linear, GitHub…) sans coder
- ✅ **Confirmation** — aucune action irréversible (envoi mail, event) sans ton feu vert
- ✅ **Tâches** — todo (ajouter / lister / terminer)
- ⏰ **Rappels datés** — « rappelle-moi d'appeler Paul demain 15h »
- 🧠 **Mémoire** — se souvient de toi (préférences, proches, projets) via pgvector + **résumé glissant** des longues discussions
- 📡 **Proactivité** — veille de sujets + nudges autonomes, avec garde-fous (quiet hours, plafond/jour, opt-out)
- 🤝 **Exécuteur délégué** — un sous-agent neutre exécute les sous-tâches, Milo garde la voix
- 🔌 **Canal abstrait** (`Messenger`) — LoopMessage (iMessage) aujourd'hui ; Telegram / BlueBubbles demain sans réécrire l'agent

## 🏗 Architecture
```
Contacts ⇄ iMessage ⇄ LoopMessage ⇄ webhook (Hono) ─enqueue→ Redis (BullMQ)
   → worker (agent Claude + outils + MCP) → réponse en bulles (multimodal en entrée)
   + scheduler (rappels · veille · nudges · triage email · brief · automations) → garde-fous
   + OAuth Google (Gmail + Agenda) ⇄ tokens chiffrés en base
   Postgres + pgvector (users, messages, mémoire, tâches, rappels, veille,
                        intégrations, automations, actions en attente, MCP)
```
Un seul process (`src/start.ts`) lance le webhook **et** le worker (séparable via `MILO_ROLE`).

## 🧩 Stack
Claude (`@anthropic-ai/sdk`, tool runner + connecteurs MCP) · TypeScript + tsx · Hono · BullMQ + Redis · Postgres + pgvector · Exa (recherche) · Google APIs (Gmail/Agenda, REST) · OpenAI Whisper (notes vocales, optionnel) · Railway

## 🚀 Démarrer en local
1. **Pré-requis** : Node ≥ 20, Docker.
2. `docker compose up -d` (Postgres+pgvector + Redis)
3. `cp .env.example .env` puis remplis au minimum `ANTHROPIC_API_KEY` + `MILO_ALLOWLIST`. Pour tester sans iMessage : `MILO_CHANNEL=console`.
4. `npm install` → `npm run db:setup`
5. `npm run dev:web` et `npm run dev:worker` (2 terminaux)

### Tester sans iMessage (mode console)
```bash
curl -X POST http://localhost:3000/webhook -H 'Content-Type: application/json' \
  -d '{"from":"+33612345678","text":"salut Milo"}'
```
La réponse s'affiche dans les logs du worker. (Le numéro doit être dans `MILO_ALLOWLIST`.)

### Vrai iMessage
Voir [`docs/loopmessage-setup.md`](docs/loopmessage-setup.md) : compte LoopMessage, webhook, `MILO_CHANNEL=loopmessage`, ngrok (ou Railway).

## ☁️ Déploiement (Railway)
1 service applicatif (`npm start`) + Postgres (image `pgvector/pgvector`) + Redis, le tout en réseau privé. Le service web applique la migration au démarrage. Voir le design : [`docs/plans/`](docs/plans/).

## ⚙️ Variables d'environnement
| Variable | Rôle |
|---|---|
| `ANTHROPIC_API_KEY` | clé API Claude (requis) |
| `MILO_MODEL` / `MILO_MODEL_LIGHT` | modèle principal / léger (déf. `claude-sonnet-4-6` / `claude-haiku-4-5`) |
| `ANTHROPIC_BASE_URL` | optionnel — passerelle wire-compatible (ex. OpenRouter natif) |
| `MILO_CHANNEL` | `loopmessage` ou `console` |
| `MILO_ALLOWLIST` | numéros autorisés (E.164, séparés par virgule) |
| `LOOPMESSAGE_AUTH_KEY` / `_SENDER_NAME` / `_WEBHOOK_SECRET` | canal iMessage |
| `EXA_API_KEY` | recherche web optimisée (sinon repli natif) |
| `VOYAGE_API_KEY` | embeddings mémoire (sinon repli plein-texte) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Gmail + Agenda (sinon outils absents) |
| `MILO_PUBLIC_URL` | URL publique (callback OAuth + liens) |
| `MILO_ENCRYPTION_KEY` | chiffre les tokens OAuth au repos (obligatoire en prod si Google) |
| `OPENAI_API_KEY` | transcription des notes vocales (Whisper, optionnel) |
| `DATABASE_URL` / `REDIS_URL` | infra |
| `MILO_HISTORY` / `MILO_PROACTIVE_DAILY_CAP` / `MILO_NUDGE_EVERY_HOURS` | réglages |
| `MILO_BRIEF_HOUR` / `MILO_EMAIL_SWEEP_MINUTES` | heure du brief · fréquence du triage email |

## 📂 Structure
```
src/
  web.ts · worker.ts · start.ts        # entrées (webhook + OAuth, jobs, point d'entrée)
  agent/                               # cerveau (tool runner, prompt, outils, exécuteur, client)
  messenger/                           # abstraction canal (loopmessage, console)
  google/                              # OAuth + Gmail + Agenda (REST)
  search.ts · veille.ts · nudge.ts     # recherche Exa, veille, nudges
  emailTriage.ts · brief.ts            # triage email proactif · brief quotidien
  automations.ts · recipes.ts          # triggers récurrents/email · presets
  pending.ts                           # actions en attente (tap-to-approve)
  attachments.ts                       # multimodal (images/PDF/voix)
  mcp.ts · integrations.ts · crypto.ts # serveurs MCP · tokens chiffrés
  memory.ts · compaction.ts            # mémoire long terme + résumé glissant
  tasks.ts · reminders.ts · store.ts   # données
db/schema.sql · docker-compose.yml · docs/
```

### Brancher Gmail + Agenda (OAuth Google)
1. Sur [console.cloud.google.com](https://console.cloud.google.com) : active les API **Gmail** et **Calendar**, crée un identifiant **OAuth client (Web)**.
2. Redirection autorisée : `<MILO_PUBLIC_URL>/oauth/google/callback`.
3. Renseigne `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MILO_PUBLIC_URL`, `MILO_ENCRYPTION_KEY`.
4. Sur iMessage : « connecte mon gmail » → Milo te donne un lien → tu autorises → c'est branché.

---
Projet perso. Pas de licence par défaut (tous droits réservés) — ajoute-en une si tu veux le rendre réutilisable.
