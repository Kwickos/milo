# Milo 🤖

Assistant IA personnel **proactif**, accessible directement dans **iMessage** — comme un pote à qui tu textes. Construit avec **Claude**, **TypeScript**, déployé sur **Railway**.

> Pensé pour toi + quelques proches (liste blanche). Inspiré de Poke.com.

## ✨ Fonctionnalités
- 💬 **Chat naturel** — répond comme un pote (ton texto, court, multi-bulles, zéro markdown)
- 🔎 **Recherche web** token-optimisée via **Exa** (réponse synthétisée + sources, ~10-50× moins de tokens que la recherche brute)
- ✅ **Tâches** — todo (ajouter / lister / terminer)
- ⏰ **Rappels datés** — « rappelle-moi d'appeler Paul demain 15h »
- 🧠 **Mémoire** — se souvient de toi (préférences, proches, projets) via pgvector + **résumé glissant** des longues discussions
- 📡 **Proactivité** — veille de sujets + nudges autonomes, avec garde-fous (quiet hours, plafond/jour, opt-out)
- 🔌 **Canal abstrait** (`Messenger`) — LoopMessage (iMessage) aujourd'hui ; Telegram / BlueBubbles demain sans réécrire l'agent

## 🏗 Architecture
```
Contacts ⇄ iMessage ⇄ LoopMessage ⇄ webhook (Hono) ─enqueue→ Redis (BullMQ)
   → worker (agent Claude + outils) → réponse en bulles
   + scheduler (rappels · veille Exa · nudges) → garde-fous
   Postgres + pgvector (users, messages, mémoire, tâches, rappels, veille)
```
Un seul process (`src/start.ts`) lance le webhook **et** le worker (séparable via `MILO_ROLE`).

## 🧩 Stack
Claude (`@anthropic-ai/sdk`, tool runner) · TypeScript + tsx · Hono · BullMQ + Redis · Postgres + pgvector · Exa (recherche) · Railway

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
| `DATABASE_URL` / `REDIS_URL` | infra |
| `MILO_HISTORY` / `MILO_PROACTIVE_DAILY_CAP` / `MILO_NUDGE_EVERY_HOURS` | réglages |

## 📂 Structure
```
src/
  web.ts · worker.ts · start.ts      # entrées (webhook, jobs, point d'entrée)
  agent/                             # cerveau (tool runner, prompt, outils, client)
  messenger/                         # abstraction canal (loopmessage, console)
  search.ts · veille.ts · nudge.ts   # recherche Exa, veille, nudges
  memory.ts · compaction.ts          # mémoire long terme + résumé glissant
  tasks.ts · reminders.ts · store.ts # données
db/schema.sql · docker-compose.yml · docs/
```

---
Projet perso. Pas de licence par défaut (tous droits réservés) — ajoute-en une si tu veux le rendre réutilisable.
