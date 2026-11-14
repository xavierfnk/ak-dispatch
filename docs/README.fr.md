# Planificateur de répartition des patientes

[English](../README.md) | **Français**

**Patient Dispatch Planner** est une application web locale. Elle aide les coordinatrices de maternité à préparer des propositions de répartition des patientes entre les équipes de sages-femmes. Vous pouvez diviser chaque mois prévu d’accouchement en une à quatre cohortes. Une personne doit vérifier chaque proposition. L’application ne décide pas de l’affectation finale.

L’application utilise React et TypeScript. Elle s’exécute entièrement dans le navigateur. Le module de calcul valide les informations, demande les temps de trajet et exécute l’optimiseur d’affectation dans la page. La seule requête réseau pendant la planification est adressée à l’API Google Routes, après un calcul explicite.

## Fonctionnement

- Configurez les équipes, leurs membres et lieux, ainsi que les capacités minimale et maximale de chaque équipe.
- Divisez un mois en cohortes. Saisissez les lieux, la parité et l’éligibilité PEC 100 % des patientes. Si vous confirmez le remplacement d’un découpage, l’application supprime les cohortes existantes et leur historique.
- Lorsque vous lancez un calcul, l’application transmet les lieux des patientes et des membres d’équipe à l’API Google Routes. Elle compare les temps de trajet à vélo et en transports en commun. Elle ne transmet pas les noms, la parité, les capacités ou les affectations à Google.
- L’optimiseur répartit les patientes éligibles PEC 100 % entre les équipes actives. L’écart entre les équipes est au maximum d’une patiente. Il respecte les capacités et prend en compte les trajets et la parité. Les changements manuels respectent aussi ces contraintes.
- L’application conserve les équipes, les cohortes et les données saisies dans IndexedDB du navigateur. Vous pouvez les exporter en JSON ou les supprimer dans l’application. La clé API Google est conservée dans le stockage local du navigateur. Elle n’est pas incluse dans les exports.

L’application publiée n’a ni serveur applicatif, ni base de données cloud, ni outil d’analyse ou de télémétrie. Le calcul des trajets est une exception au traitement local. Google reçoit les lieux et les métadonnées de la requête selon les conditions du projet associé à la clé. L’application conserve les résultats Google en mémoire, mais pas dans la base locale ; ils disparaissent au rechargement de la page. L’application ne chiffre pas le stockage local. Toute personne ayant accès au profil du navigateur peut lire la clé API : restreignez-la à l’API Routes et à l’origine de l’application dans Google Cloud.

**Utilisez des données fictives jusqu’à validation par les responsables de la protection des données et les équipes juridiques de votre organisation, ainsi qu’à vérification des conditions Google Maps Platform.** Voir la [documentation sur le traitement des données](traitement-des-donnees.md).

## Utilisation

L’application est un site statique. Ouvrez l’URL déployée, ou compilez `web/dist` et servez-le depuis n’importe quel hébergement statique. Si GitHub Pages est activé pour ce dépôt avec la source **GitHub Actions**, le workflow de déploiement publie l’application à chaque envoi sur `main`.

## Développement

Prérequis : Node.js 22 et, facultativement, Task. Installez les dépendances avec `cd web && npm ci`.

- `task dev` : lance Vite avec rechargement de l’interface.
- `task test` : lance les tests de l’interface et du calcul.
- `task build` : vérifie les types et compile le site statique dans `web/dist`.
- `task check` : tests et compilation de production.

Sans Task, lancez `cd web && npm run dev`, `npm test` ou `npm run build`. Le code de l’interface et du calcul se trouve dans `web/` ; l’optimiseur est dans `web/src/dispatch/`.

## Clé API Google Routes

Chaque utilisateur fournit sa propre clé Google Maps Platform dans **Configuration**. Activez l’API Routes et restreignez la clé à cette API et à l’origine déployée (en-tête HTTP referrer). Définissez des quotas et des alertes de facturation. Le navigateur conserve la clé dans le stockage local ; elle n’est ni dans IndexedDB ni dans les exports. Ne placez pas de clé personnelle dans le code source ou dans un dépôt public.

## Déploiement

`web/dist` est un ensemble statique. Le workflow GitHub Actions fourni compile l’interface et déploie le résultat sur GitHub Pages. Tout hébergement statique convient.
