# Rebond

Jeu de plateforme 3D multijoueur (1 à 4 joueurs), version autonome.

## Mettre en ligne sur Render (gratuit)

1. Dépose tout le contenu de ce dossier dans un dépôt GitHub (lien « uploading an existing file »).
2. Sur Render : New > Web Service > choisis ce dépôt.
3. Build Command : `npm install` · Start Command : `npm start` · Instance Type : Free.
4. Clique sur « Deploy Web Service ». Au bout de 2 à 3 minutes, l'adresse du jeu s'affiche en haut de la page (du type `https://rebond-xxxx.onrender.com`).

L'offre gratuite met le serveur en veille après 15 minutes sans joueur : la première ouverture suivante prend environ une minute.

## Mettre à jour le jeu

Remplace `public/index.html` dans le dépôt GitHub. Render redéploie tout seul.

## Lancer en local

```
npm install
npm start
```

Puis ouvre http://localhost:3000
