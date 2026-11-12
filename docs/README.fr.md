# Planificateur de répartition des patientes

[English](../README.md) | **Français**

**Patient Dispatch Planner** est une application de bureau locale. Elle aide les coordinatrices de maternité à préparer des propositions de répartition des patientes entre les équipes de sages-femmes. Vous pouvez diviser chaque mois prévu d’accouchement en une à quatre cohortes. Une personne doit vérifier chaque proposition. L’application ne décide pas de l’affectation finale.

## Fonctionnement

- Configurez les équipes, leurs membres et lieux, ainsi que les capacités minimale et maximale de chaque équipe.
- Divisez un mois en cohortes. Saisissez les lieux, la parité et l’éligibilité PEC 100 % des patientes. Si vous confirmez le remplacement d’un découpage, l’application supprime les cohortes existantes et leur historique.
- Lorsque vous lancez un calcul, l’application transmet les lieux des patientes et des membres d’équipe à l’API Google Routes. Elle compare les temps de trajet à vélo et en transports en commun. Elle ne transmet pas les noms, la parité, les capacités ou les affectations à Google.
- Le service Go local répartit les patientes éligibles PEC 100 % entre les équipes actives. L’écart entre les équipes est au maximum d’une patiente. Il respecte les capacités et prend en compte les trajets et la parité. Les changements manuels respectent aussi ces contraintes.

L’interface React/TypeScript communique directement avec le service Go par Wails. L’application conserve les équipes, les cohortes et les données saisies dans IndexedDB du WebView. Le trousseau du système d’exploitation conserve les clés API Google. L’application conserve les résultats Google en mémoire, mais pas dans la base locale.

L’application publiée n’a ni serveur applicatif distant, ni base de données cloud, ni outil d’analyse ou de télémétrie. Elle contacte GitHub uniquement lorsque vous recherchez une mise à jour dans **Configuration → Mises à jour**. Elle n’envoie alors aucune donnée métier. Le calcul des trajets est une autre exception au traitement local. Google reçoit les lieux et les métadonnées de la requête selon les conditions du projet associé à la clé. L’application ne chiffre pas le stockage local.

**Utilisez des données fictives jusqu’à validation par les responsables de la protection des données et les équipes juridiques de votre organisation, ainsi qu’à vérification des conditions Google Maps Platform.** Voir la [documentation sur le traitement des données](traitement-des-donnees.md).

## Installation

Téléchargez la dernière version depuis les [versions publiées sur GitHub](https://github.com/xavierfnk/ak-dispatch/releases/latest). N’ouvrez le fichier que si vous faites confiance à sa source et souhaitez installer l’application.

- **Windows :** téléchargez `patient-dispatch-planner-windows-x64.exe`. Créez le dossier `%LOCALAPPDATA%\Programs\Patient Dispatch Planner`, déplacez-y le fichier, renommez-le `patient-dispatch-planner.exe`, puis ouvrez-le. Si SmartScreen indique que l’application est inconnue, sélectionnez **Informations complémentaires → Exécuter quand même** si vous faites confiance au fichier.
- **macOS (puce Apple) :** téléchargez le ZIP `macos-arm64`. Décompressez-le et déplacez `patient-dispatch-planner.app` dans `~/Applications` (créez ce dossier si nécessaire), puis ouvrez l’application. Si macOS la bloque, ouvrez **Réglages Système → Confidentialité et sécurité**, sélectionnez **Ouvrir quand même**, puis confirmez. Consultez les [instructions d’Apple](https://support.apple.com/fr-fr/102445). Les Mac Intel ne reçoivent plus de nouvelles versions ni de mises à jour.
- **Linux x64 :** sur Ubuntu 24.04, installez le moteur nécessaire avec `sudo apt install libwebkitgtk-6.0-4` et utilisez une session de bureau avec un trousseau Secret Service déverrouillé pour la clé API. Téléchargez `patient-dispatch-planner-linux-x64`, puis installez-le avec votre compte habituel (adaptez `~/Downloads` si nécessaire) :

  ```sh
  mkdir -p ~/.local/bin
  install -m 755 ~/Downloads/patient-dispatch-planner-linux-x64 ~/.local/bin/patient-dispatch-planner
  ~/.local/bin/patient-dispatch-planner
  ```

  Conservez l’exécutable à cet emplacement et les droits d’écriture sur le dossier pour les mises à jour sur place. Ne lancez pas l’application avec `sudo` : les données locales et les identifiants appartiennent à votre compte de bureau. L’exécutable est compilé sur Ubuntu 24.04 ; d’autres distributions ou versions plus anciennes peuvent manquer de bibliothèques compatibles.

L’exécutable Windows n’est pas signé. L’application macOS n’est ni signée avec un Developer ID ni notariée. Ces avertissements sont donc attendus. Sur un appareil géré, le contournement peut être interdit. Contactez votre administrateur plutôt que de désactiver les protections de sécurité. L’application peut installer les mises à jour dans ces emplacements si votre compte peut écrire dans le dossier.

Pour rechercher une mise à jour, ouvrez **Configuration → Mises à jour**, puis choisissez **Installer et redémarrer**. Si la nouvelle version n’est pas encore prête pour votre plateforme, réessayez plus tard. Les anciennes versions de l’application peuvent afficher une erreur de recherche à la place. L’application vérifie l’empreinte SHA-256 et la signature Ed25519 du fichier téléchargé avant de se remplacer.

## Développement

Prérequis : la version de Go indiquée dans `server/go.mod`, Node.js 22, la CLI Wails v3 et ses prérequis de plateforme (outils de ligne de commande Xcode sur macOS ; WebView2 sur Windows ; compilateur C, `libgtk-4-dev` et `libwebkitgtk-6.0-dev` sur Ubuntu 24.04). Task est facultatif.

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
task dev       # développement avec rechargement de l’interface
task build     # paquet de bureau pour la plateforme actuelle
task check     # tests Go, go vet et compilation du paquet
```

Pour lancer séparément les contrôles Go : `cd server && go test ./... && go vet ./...`. Pour compiler l’interface seule, générez d’abord les bindings Wails depuis `server/cmd/desktop` avec `wails3 generate bindings -clean -ts`, puis lancez `cd web && npm ci && npm run build`.
