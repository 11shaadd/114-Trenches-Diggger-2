# 🚀 Guide d'Installation — SolSniper Bot

## Ce guide est fait pour toi qui débutes. Chaque étape est expliquée en détail.

---

## Étape 1 : Installer Node.js

Node.js est le moteur qui fait tourner le bot. C'est comme le "moteur" de ta voiture.

1. Va sur **https://nodejs.org/**
2. Télécharge la version **LTS** (le gros bouton vert)
3. Lance l'installeur et clique "Next" à chaque étape (garde les options par défaut)
4. Pour vérifier que ça marche, ouvre un **terminal** :
   - Appuie sur `Windows + R`, tape `cmd`, puis Entrée
   - Tape : `node --version`
   - Tu devrais voir un numéro comme `v20.x.x`
   - Tape aussi : `npm --version`
   - Tu devrais voir un numéro comme `10.x.x`

---

## Étape 2 : Installer un éditeur de code

Tu auras besoin de modifier quelques fichiers. Je recommande **Visual Studio Code** (gratuit) :

1. Va sur **https://code.visualstudio.com/**
2. Télécharge et installe

---

## Étape 3 : Préparer le projet

1. Crée un dossier quelque part sur ton PC, par exemple `C:\solsniper-bot`
2. Copie TOUS les fichiers du projet dans ce dossier (garde la structure de dossiers intacte)
3. Ouvre un terminal dans ce dossier :
   - Ouvre l'Explorateur Windows, navigue vers `C:\solsniper-bot`
   - Clique dans la barre d'adresse, tape `cmd`, puis Entrée
   - Un terminal s'ouvre directement dans le bon dossier

4. Installe les dépendances (les bibliothèques dont le bot a besoin) :

```
npm install
```

Attends que ça finisse (ça peut prendre 1-2 minutes). Tu verras un dossier `node_modules` apparaître.

---

## Étape 4 : Créer un compte Helius (gratuit)

Helius est le "point d'accès" du bot à la blockchain Solana.

1. Va sur **https://www.helius.dev/**
2. Clique "Sign Up" et crée un compte
3. Une fois connecté, tu verras ton **API Key** sur le dashboard
4. Copie cette clé, tu en auras besoin à l'étape 6

---

## Étape 5 : Créer un Webhook Discord

1. Ouvre Discord et va sur ton serveur
2. Crée un salon dédié, par exemple `#solsniper-bot`
3. Clique sur la roue ⚙️ à côté du nom du salon
4. Va dans **Intégrations** → **Webhooks** → **Nouveau webhook**
5. Donne-lui un nom (ex: "SolSniper")
6. Clique **Copier l'URL du webhook**
7. Garde cette URL, tu en auras besoin à l'étape 6

---

## Étape 6 : Configurer le bot

1. Dans le dossier du projet, trouve le fichier `.env.example`
2. **Copie-le** et renomme la copie en `.env` (sans le .example)
   - Dans le terminal : `copy .env.example .env`
3. Ouvre `.env` avec VS Code ou le Bloc-notes
4. Remplis les valeurs :

```
PRIVATE_KEY=ta_cle_privee_ici
HELIUS_API_KEY=ta_cle_helius_ici
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=ta_cle_helius_ici
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PAPER_TRADING=true
```

### Comment trouver ta clé privée ?
- **Phantom** : Paramètres → Sécurité → Exporter la clé privée
- **Solflare** : Paramètres → Export Private Key

⚠️ **SÉCURITÉ** : Utilise un wallet DÉDIÉ au bot, pas ton wallet principal !

---

## Étape 7 : Premier lancement (Paper Trading)

Le mode Paper Trading simule les trades sans utiliser de vrais SOL. COMMENCE TOUJOURS PAR ÇA.

1. Vérifie que `PAPER_TRADING=true` dans ton `.env`
2. Dans le terminal, lance :

```
npm run dev
```

3. Tu devrais voir :

```
  ╔══════════════════════════════════════╗
  ║        🤖  SolSniper Bot  🤖         ║
  ║   Trading automatisé de memecoins    ║
  ║            Solana Network            ║
  ╚══════════════════════════════════════╝

📝 Mode PAPER TRADING activé — aucun vrai SOL ne sera dépensé.
```

4. Le bot va commencer à scanner les tokens et les notifications arriveront sur Discord
5. Laisse-le tourner quelques heures et observe les résultats

Pour arrêter le bot : appuie sur `Ctrl + C` dans le terminal.

---

## Étape 8 : Passer en mode réel (quand tu es prêt)

⚠️ Seulement après avoir observé le Paper Trading pendant au moins 24-48h !

1. Ouvre ton fichier `.env`
2. Change `PAPER_TRADING=true` en `PAPER_TRADING=false`
3. Assure-toi d'avoir au moins 0.6 SOL dans le wallet du bot
4. Relance le bot : `npm run dev`

---

## 🔧 Commandes utiles

| Commande | Description |
|----------|-------------|
| `npm run dev` | Lance le bot en mode développement |
| `npm run build` | Compile le TypeScript (pour production) |
| `npm start` | Lance la version compilée |
| `Ctrl + C` | Arrête le bot proprement |

---

## 🐛 Résolution de problèmes courants

### "PRIVATE_KEY manquante dans le fichier .env"
→ Tu n'as pas créé le fichier `.env` ou la clé privée est vide

### "Cannot find module '...'"
→ Tu n'as pas lancé `npm install`. Lance-le dans le bon dossier.

### "Error: insufficient funds"
→ Pas assez de SOL dans le wallet. Le minimum est 0.1 SOL (réserve gas).

### Le bot ne détecte aucun token
→ C'est normal au début, il filtre beaucoup. Attends 5-10 minutes. Si toujours rien après 30 min, vérifie ta connexion internet et ton API key Helius.

### Le terminal se ferme tout seul
→ Une erreur a probablement crashé le bot. Relance avec `npm run dev` et lis le message d'erreur rouge.

---

## 📁 Structure des fichiers

```
solsniper-bot/
├── src/                      ← Code source du bot
│   ├── index.ts              ← Fichier principal (orchestrateur)
│   ├── config.ts             ← Tous les paramètres
│   ├── types.ts              ← Types TypeScript
│   ├── scanner/              ← Détection des tokens
│   │   ├── pumpfun.ts
│   │   └── dexscreener.ts
│   ├── analyzer/
│   │   └── scorer.ts         ← Système de scoring
│   ├── risk/
│   │   └── manager.ts        ← Gestion du capital
│   ├── executor/
│   │   └── jupiter.ts        ← Achats/ventes
│   ├── monitor/
│   │   └── positions.ts      ← Trailing stop & TP
│   ├── notifier/
│   │   └── discord.ts        ← Notifications
│   └── utils/
│       ├── solana.ts
│       ├── logger.ts
│       └── storage.ts
├── data/                     ← Logs et historique (créé automatiquement)
│   ├── bot.log
│   └── trades.json
├── .env                      ← Tes clés secrètes (NE PAS PARTAGER)
├── .env.example              ← Modèle du fichier .env
├── package.json
└── tsconfig.json
```
