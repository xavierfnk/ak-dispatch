# Planificateur de répartition des patientes

[English](../README.md) | **Français**

**Patient Dispatch Planner** est une application de bureau locale destinée à aider les coordinatrices de maternité à préparer des propositions de répartition des patientes entre des équipes de sages-femmes. Chaque mois prévu d’accouchement peut être divisé en une à quatre cohortes. Toute proposition reste à vérifier par une personne : l’application ne décide pas de l’affectation finale.

## Fonctionnement

- Configurez les équipes, leurs membres et lieux, ainsi que les capacités minimale et maximale de chaque équipe.
- Divisez un mois en cohortes et saisissez les lieux, la parité et l’éligibilité PEC 100 % des patientes. Remplacer un découpage existant supprime les cohortes et leur historique après confirmation.
- Lorsqu’une coordinatrice lance explicitement un calcul, l’application transmet les lieux des patientes et des membres d’équipe à l’API Google Routes afin de comparer les trajets à vélo et en transports en commun. Les noms, la parité, les capacités et les affectations ne sont pas transmis à Google.
- Le service Go local répartit les patientes éligibles PEC 100 % équitablement entre les équipes actives (écart maximal d’une patiente), respecte les capacités et prend en compte les trajets et la parité. Les changements manuels respectent également ces contraintes.

L’interface React/TypeScript communique directement avec le service Go par Wails. Les équipes, cohortes et données de formulaire sont conservées dans IndexedDB du WebView de l’application. Les clés API Google sont enregistrées dans le trousseau du système d’exploitation. Les résultats Google sont conservés en mémoire et ne sont pas enregistrés dans la base locale.

L’application publiée n’a ni serveur applicatif distant, ni base de données cloud, ni analytique ni télémétrie. Une recherche de mise à jour GitHub est effectuée uniquement sur action explicite dans **Configuration → Mises à jour** ; elle n’envoie aucune donnée métier. L’appel à Google est une autre exception au traitement local : Google reçoit les lieux transmis ainsi que les métadonnées de requête, selon les conditions applicables au projet associé à la clé. Le stockage local n’est pas chiffré par l’application.

Pour permettre la mise à jour intégrée, placez l’exécutable Windows dans `%LOCALAPPDATA%\Programs\Patient Dispatch Planner\patient-dispatch-planner.exe` ou l’application macOS dans `~/Applications/patient-dispatch-planner.app`. Les mises à jour remplacent ces fichiers dans leur emplacement actuel, après vérification de l’empreinte SHA-256 et de la signature Ed25519, et nécessitent un dossier accessible en écriture par l’utilisateur.

**Utilisez des données fictives jusqu’à validation par les responsables de la protection des données et les équipes juridiques de votre organisation, ainsi qu’à vérification des conditions Google Maps Platform.** Voir la [documentation sur le traitement des données](traitement-des-donnees.md).

## Développement

Prérequis : la version de Go indiquée dans `server/go.mod`, Node.js 22, la CLI Wails v3 et ses prérequis de plateforme (outils de ligne de commande Xcode sur macOS ; WebView2 sur Windows). Task est facultatif.

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
task dev       # développement avec rechargement de l’interface
task build     # paquet de bureau pour la plateforme actuelle
task check     # tests Go, go vet et compilation du paquet
```

Pour lancer séparément les contrôles Go : `cd server && go test ./... && go vet ./...`. Pour compiler l’interface seule, générez d’abord les bindings Wails depuis `server/cmd/desktop` avec `wails3 generate bindings -clean -ts`, puis lancez `cd web && npm ci && npm run build`.
