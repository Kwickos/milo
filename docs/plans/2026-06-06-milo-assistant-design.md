# Milo — Assistant IA personnel sur iMessage

**Date :** 2026-06-06
**Statut :** Design validé (brainstorming) — prêt pour implémentation
**Auteur :** Fabien + Claude

---

## 1. Vision & périmètre

Milo est un **assistant personnel proactif** accessible directement dans **iMessage**, pour
**toi + quelques proches** (liste blanche). On lui parle comme à un ami. Il sait :

- **Répondre & chercher** — questions, recherche web, résumé de liens/documents.
- **Tâches & mémoire** — gérer une todo, capturer des idées, et surtout **se souvenir** de chaque
  personne (préférences, contexte, proches) au fil du temps (« second cerveau »).
- **Proactivité** — Milo écrit en premier dans 3 cas :
  1. **Rappels datés** (« rappelle-moi d'appeler Paul demain 15h »),
  2. **Veille de sujets** (« préviens-moi s'il y a du nouveau sur X »),
  3. **Nudges autonomes** (relancer une tâche en retard, prendre des nouvelles — avec garde-fous).

**Hors périmètre MVP (volontairement) :** intégration email/agenda (évite l'OAuth Google),
facturation, onboarding produit, multi-locataire à grande échelle.

**Principe directeur :** qualité maximale là où ça compte (boucle agentique, mémoire,
proactivité) ; simplicité partout ailleurs (YAGNI).

---

## 2. Décisions clés

| Sujet | Décision | Raison |
|---|---|---|
| Canal | **iMessage via API Sendblue** | Bulle bleue sans gérer de Mac ; sandbox gratuit ; plan « AI Agent » ; SDK Node. |
| Hébergement | **Railway** | Cerveau + workers + Postgres + Redis managés. |
| Langage | **TypeScript** | Un seul langage du webhook à l'agent ; typage fort des outils (Zod) → agent fiable. |
| Moteur IA | **`@anthropic-ai/sdk` + tool runner (beta)** | Tier « Claude API + tool use » : on héberge la boucle, contrôle total. |
| Modèle principal | **`claude-opus-4-8`** (adaptive thinking, effort `high`) | Le plus capable ; raisonnement agentique. |
| Modèle « léger » | **`claude-haiku-4-5`** | Évaluations de fond à haute fréquence (« dois-je nudger ? »), classification. |
| Recherche/veille | **Outils serveur intégrés** `web_search_20260209` + `web_fetch_20260209` | Aucun service tiers ; dynamic filtering sur Opus 4.8. |
| Mémoire | **Postgres + pgvector**, exposée via outils custom | Mémoire structurée par utilisateur, contrôlable (mieux que la memory-tool fichier pour du multi-utilisateur). |
| Jobs/planif | **BullMQ (Redis)** | Rappels (jobs différés), veille & nudges (jobs répétables). |

---

## 3. Architecture

```
                          ┌──────────────────────────── RAILWAY ────────────────────────────┐
                          │                                                                  │
  Contacts (iMessage)     │   ┌─────────────┐   enqueue   ┌──────────────┐                   │
        │                 │   │  web         │──────────▶ │  worker      │                   │
        ▼                 │   │  (Hono)      │            │  (agent)     │── Claude Opus 4.8  │
  ┌──────────┐  webhook   │   │  /webhook    │            │  tool runner │   (+ Haiku 4.5)    │
  │ Sendblue │──────────▶ │   │  + signature │            └──────┬───────┘                   │
  │ (Macs)   │            │   │  + allowlist │                   │ outils                     │
  │          │◀────────── │   └─────────────┘        ┌──────────┼───────────┬──────────┐     │
  └──────────┘  send API  │                          ▼          ▼           ▼          ▼     │
                          │                   web_search/   tâches &     mémoire    envoyer   │
                          │                   web_fetch     rappels    (pgvector)   iMessage  │
                          │   ┌─────────────┐  déclenche   ┌──────────────┐                   │
                          │   │ scheduler   │────────────▶ │ worker       │ (réutilise        │
                          │   │ (BullMQ)    │ rappels/veille│ (proactif)  │  les mêmes outils)│
                          │   └─────────────┘ /nudges       └──────────────┘                   │
                          │                                                                  │
                          │   Postgres + pgvector   ·   Redis (file de jobs)                  │
                          └──────────────────────────────────────────────────────────────────┘
```

**Services Railway :**
- `web` — serveur Hono : reçoit le webhook Sendblue, vérifie la signature, contrôle l'allowlist,
  met en file, répond `200` immédiatement. Aucune logique lourde ici.
- `worker` — consomme la file : exécute la boucle agentique (tool runner), appelle les outils,
  envoie la réponse via Sendblue. Sert **aussi** la proactivité (mêmes outils).
- `Postgres` (+ extension `pgvector`) — état persistant.
- `Redis` — file BullMQ + planification.

**Pourquoi cette séparation :** le webhook ne doit jamais bloquer (timeouts Sendblue). Tout le
travail est asynchrone → robuste, ré-essayable, et la proactivité réutilise exactement le worker.

---

## 4. Le cerveau (boucle agentique)

- **SDK :** `@anthropic-ai/sdk`, helper `betaZodTool` + `client.beta.messages.toolRunner()` →
  la boucle outils est gérée par le SDK (appel → exécution outil → résultat → recommence).
- **Modèle :** `claude-opus-4-8`, `thinking: { type: "adaptive" }`, `output_config: { effort: "high" }`.
- **System prompt :** définit la personnalité de Milo (ami, concis, tutoie, pas de préambule),
  les règles de proactivité, et le contexte utilisateur courant. **Gelé** (pas de date/heure
  interpolée dedans → cache intact). Le contexte volatile (profil, mémoire pertinente, heure
  locale) est injecté via des messages, pas dans le system prompt.
- **Prompt caching :** breakpoint sur le dernier bloc system → tools + system mis en cache.
  Historique mis en cache par tour. Vérifier `usage.cache_read_input_tokens`.
- **Contexte long :** compaction beta (`compact-2026-01-12`) si une conversation devient très longue.
- **Tiering :** la boucle conversationnelle = Opus 4.8 (qualité). Les **ticks de fond** (veille,
  « dois-je nudger ? ») commencent par une éval **Haiku 4.5** bon marché ; on n'escalade vers
  Opus que s'il y a vraiment quelque chose à dire.

---

## 5. Les outils

### Intégrés (côté Anthropic, zéro infra)
- `web_search_20260209` — recherche web (avec dynamic filtering sur Opus 4.8).
- `web_fetch_20260209` — récupère le contenu d'une URL (résumé de liens envoyés par l'user).

### Custom (exécutés par le worker, schémas Zod)
- `create_reminder(text, due_at)` / `list_reminders()` / `cancel_reminder(id)` — pose un job différé.
- `add_task(text)` / `list_tasks()` / `complete_task(id)` — todo par utilisateur.
- `save_memory(content, kind)` — écrit une mémoire long terme (embeddée).
- `recall_memory(query)` — recherche sémantique dans la mémoire (pgvector).
- `watch_topic(topic, cadence)` / `list_watches()` / `stop_watch(id)` — crée une veille.
- `send_message(text)` — **outil dédié** pour l'envoi iMessage (gating possible, rendu propre,
  audit) plutôt que de laisser le modèle « parler dans le vide ».

> Design des outils : on **promeut en outil dédié** ce qui doit être gaté/audité/rendu
> (envoi, mémoire, rappels). On garde les outils intégrés pour la recherche.

---

## 6. La mémoire (« second cerveau »)

- **Stockage :** Postgres + `pgvector`. Chaque mémoire = `{ user_id, kind, content, embedding,
  created_at, source }`. `kind` ∈ `profil | préférence | fait | relation | projet`.
- **Écriture :** Milo décide (via `save_memory`) quand un élément mérite d'être retenu — ou on
  fait une passe d'extraction post-conversation (Haiku) qui propose des mémoires.
- **Lecture :** à chaque message entrant, on récupère le **profil** de l'user + les **N mémoires
  les plus pertinentes** (recherche vectorielle sur l'embedding du message) et on les injecte dans
  le contexte. Milo peut aussi appeler `recall_memory` explicitement.
- **Embeddings :** via un modèle d'embedding (à brancher) ; au pire, recherche plein-texte
  Postgres en repli pour le MVP.
- **Isolation :** tout est scié par `user_id`. Jamais de fuite entre proches.

---

## 7. Le moteur de proactivité

Trois mécaniques, toutes via **BullMQ** :

1. **Rappels datés** — `create_reminder` crée un **job différé** à `due_at`. À l'échéance, le
   worker formule un message (« 👋 Tu m'avais demandé d'appeler Paul ») et l'envoie.
2. **Veille de sujets** — `watch_topic` crée un **job répétable** (cadence configurable). À chaque
   tick : `web_search` sur le sujet → compare au **dernier état connu** stocké → ne ping QUE s'il
   y a du neuf (dédup par hash/URL). État dans `monitored_topics.last_seen`.
3. **Nudges autonomes** — un **tick par utilisateur** (ex. 1×/jour) :
   - éval **Haiku** : « vu les tâches/rappels/mémoire et la dernière interaction, y a-t-il une
     raison *légitime* d'écrire ? » → renvoie `{ should_nudge, reason }`.
   - si oui → Opus formule un message court et utile.

**Garde-fous anti-relou (essentiels) :**
- **Quiet hours** par utilisateur (pas de message la nuit, selon son fuseau).
- **Plafond** de N messages proactifs / jour / utilisateur (journalisé dans `proactive_log`).
- **Anti-doublon** : ne pas reposer un nudge déjà envoyé récemment.
- **Opt-out** simple par message (« arrête les rappels sur X »).

---

## 8. Modèle de données (Postgres)

```
users(id, phone, display_name, timezone, quiet_hours_start, quiet_hours_end,
      is_allowed, profile_json, created_at)
messages(id, user_id, direction, body, provider_msg_id UNIQUE, created_at)   -- historique + idempotence
memories(id, user_id, kind, content, embedding vector, source, created_at)
tasks(id, user_id, text, status, created_at, completed_at)
reminders(id, user_id, text, due_at, job_id, status, created_at)
monitored_topics(id, user_id, topic, cadence, last_seen_json, job_id, status, created_at)
proactive_log(id, user_id, kind, body, created_at)                           -- rate limiting
```

`provider_msg_id UNIQUE` → **idempotence** (un même webnook rejoué ne double pas le traitement).

---

## 9. Sécurité

- **Allowlist** : le webhook rejette tout numéro absent de `users.is_allowed`. (On peut auto-créer
  un user « en attente » et te notifier, mais par défaut : refus silencieux.)
- **Vérification de signature** du webhook Sendblue (corps brut, avant tout parsing JSON).
- **Secrets** (clé Anthropic, clé Sendblue, signing secret) → variables d'env Railway, jamais en dur,
  jamais dans un prompt ni un message (ça persiste dans l'historique).
- **Isolation par `user_id`** sur toutes les requêtes.
- **Tool gating** : `send_message` et actions à effet de bord passent par des outils dédiés,
  contrôlables.

---

## 10. Robustesse & erreurs

- **Webhook** : valider + enqueue + `200` en <1s. Jamais de travail synchrone.
- **Idempotence** : dédup sur `provider_msg_id`.
- **Retries** : BullMQ avec backoff exponentiel ; le SDK Anthropic ré-essaie déjà 429/5xx.
- **`stop_reason`** : gérer `refusal` (message poli), `max_tokens` (augmenter / streamer),
  `pause_turn` (relancer pour les outils serveur).
- **Observabilité** : logs structurés + `request_id` Anthropic ; tableau des coûts via `usage`.

---

## 11. Coûts (ordre de grandeur)

- **Sendblue** : **0 € en dev** (sandbox). Prod ≈ **100 $/ligne/mois** (plan AI Agent, inbound
  inclus, pas de frais au message).
- **Claude** : Opus 4.8 = 5 $/1M entrée, 25 $/1M sortie (lectures cache ≈ 0,1×). Haiku 4.5 =
  1 $/5 $ — d'où le tiering pour les ticks de fond.
- **Railway** : ~5–20 $/mois pour `web` + `worker` + Postgres + Redis à petite échelle.

> On peut **tout construire et tester à 0 €** (sandbox Sendblue + crédits API) avant de payer
> quoi que ce soit.

---

## 12. Roadmap d'implémentation

- **Phase 0 — Scaffolding.** Monorepo TS, projet Railway, Postgres (+pgvector), Redis, compte
  Sendblue (sandbox), variables d'env.
- **Phase 1 — Boucle écho.** webhook → file → worker → Claude → réponse → Sendblue. Allowlist +
  signature + idempotence. (« Milo répond. »)
- **Phase 2 — Outils.** web_search/web_fetch ; tasks ; reminders ; mémoire (save/recall).
- **Phase 3 — Proactivité.** scheduler : rappels datés, veille de sujets, nudges + garde-fous
  (quiet hours, plafonds).
- **Phase 4 — Finitions.** profils par personne, fuseaux, opt-out, observabilité/coûts,
  extraction mémoire post-conversation.

---

## 13. Risques & limites

- **CGU Apple / pérennité provider** : iMessage hors-Apple reste un terrain mouvant. Sendblue
  absorbe ce risque, mais c'est une dépendance forte → garder le canal **abstrait** (interface
  `Messenger`) pour pouvoir basculer (LoopMessage, WhatsApp…) sans réécrire l'agent.
- **Proactivité = double tranchant** : mal dosée, elle agace. Les garde-fous ne sont pas
  optionnels.
- **Beta tool runner** : le tool runner Anthropic est en beta — surveiller les évolutions du SDK.
- **Coût Opus** : maîtrisé par le tiering Haiku + prompt caching.

---

## Annexe — Abstraction du canal (anti-lock-in)

```ts
interface Messenger {
  send(userPhone: string, text: string): Promise<void>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseInbound(rawBody: string): { from: string; body: string; providerMsgId: string };
}
// Implémentations : SendblueMessenger (MVP), plus tard LoopMessageMessenger / WhatsAppMessenger.
```
