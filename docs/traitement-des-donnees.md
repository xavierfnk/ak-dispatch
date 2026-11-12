# Traitement et stockage des données

[English](../README.md) · [Présentation française](README.fr.md)

*Synthèse des sources juridiques vérifiées le 17 octobre 2026 ; description de l’architecture de bureau mise à jour le 31 octobre 2026. Ce document décrit le fonctionnement actuel et résume des sources publiques. Il ne constitue ni un avis juridique, ni une analyse d’impact, ni une preuve de conformité.*

## En bref

L’application est conçue pour fonctionner localement. Elle ne dispose ni de serveur applicatif ni de base cloud. Les données saisies et les résultats conservés localement restent dans le profil IndexedDB du WebView. Une adresse précise peut identifier une personne. Dans un contexte de soins de maternité, elle peut aussi révéler ou permettre de déduire des informations de santé. Lorsque vous lancez un calcul, l’application transmet les lieux des patientes et des membres d’équipe à Google Routes. La requête ne contient ni nom ni identifiant, mais cela ne rend pas automatiquement ces lieux anonymes.

**N’utilisez que des données fictives tant que le DPO et les conseils juridiques n’ont pas validé le traitement, le déploiement et les conditions Google applicables.** L’architecture locale ne vaut pas autorisation juridique ou contractuelle.

## Quelles données, où et quand ?

| Données | Traitement et stockage |
| --- | --- |
| Noms, adresses/lieux, parité et éligibilité PEC 100 % des patientes ; équipes, noms et lieux des membres ; capacités et cohortes | Saisis et conservés localement dans IndexedDB du profil WebView. Les identifiants de fiches sont créés dans l’interface. |
| Historique local éventuellement présent | Conservé dans IndexedDB ; les calculs Google de la version actuelle ne l’alimentent pas. |
| Clé API Google Maps | Conservée dans le trousseau de mots de passe du système d’exploitation, et non dans IndexedDB ou l’export. Elle est lue par le service Go local et n’est pas renvoyée à l’interface après saisie. |
| Lieux des patientes et des membres actifs, options d’itinéraire et métadonnées techniques de requête | Transmis à Google Routes uniquement lorsque l’utilisateur lance un calcul. Google traite ces données selon les conditions et politiques applicables au projet Google concerné. |
| Vérification et téléchargement d’une mise à jour | Sur action explicite de l’utilisateur, le service Go contacte l’API GitHub Releases et télécharge l’artefact de l’application correspondant au système et à l’architecture. GitHub reçoit les métadonnées ordinaires de la requête réseau (notamment l’adresse IP) ; aucune donnée de patiente, d’équipe ou de planification n’est incluse. |
| Résultats de calcul Google | Reçus par le service Go local et affichés dans l’interface ; gardés en mémoire de l’application et non enregistrés dans IndexedDB ni dans l’export. Ils disparaissent à la fermeture de l’application. |

L’export JSON peut contenir des noms, des adresses, la parité, l’éligibilité PEC 100 % et l’historique local. Protégez ce fichier comme un fichier potentiellement sensible. **Tout supprimer** efface les données des magasins locaux de l’application. Pour supprimer la clé API, utilisez l’action distincte dans Configuration. Ces actions ne suppriment pas les fichiers exportés ni les données éventuellement traitées par Google.

Dans Configuration, vous pouvez importer un export JSON de l’application sur l’appareil. La fusion conserve les éléments locaux dont l’identifiant existe aussi dans le fichier. Le remplacement supprime les données locales avant d’importer celles du fichier. La clé Google Maps reste dans le trousseau et ne change pas. Vous ne pouvez pas importer les résultats Google temporaires.

Le stockage Web local n’est pas chiffré par l’application. Sécurisez les comptes de l’appareil, utilisez le chiffrement complet du disque lorsqu’il est disponible et protégez les sauvegardes et exports.

## Parcours d’un calcul

1. L’interface valide localement les informations requises. Les noms et identifiants stables des fiches restent dans l’interface ; des jetons temporaires sont utilisés pour corréler la réponse au calcul.
2. Wails transmet la requête au service Go sur l’appareil. L’optimiseur et la logique d’affectation s’exécutent localement.
3. Pour calculer les trajets, le client Go envoie à Google Routes les lieux d’origine (membres actifs des équipes) et de destination (patientes), avec les options vélo et transports en commun. L’application ne fait pas de recherche d’adresse ou d’autocomplétion pendant la saisie.
4. Les noms, jetons, identifiants de fiches, parité, capacités, critères d’éligibilité et résultats d’affectation ne sont pas inclus dans la requête de routage. Google reçoit néanmoins les lieux et des métadonnées de requête ; l’omission de ces autres champs ne prouve pas que les lieux soient anonymes.
5. Go combine les temps de trajet disponibles avec les contraintes locales pour produire une proposition. Les calculs Google sont affichés en mémoire et ne sont pas enregistrés dans l’historique persistant.

Une adresse ou une coordonnée n’est pas nécessairement une donnée de santé par nature. Ici, l’application la relie localement à une patiente suivie pour des soins de maternité. Il est prudent de traiter le lieu comme une donnée personnelle et potentiellement comme une donnée de santé. L’envoi à un prestataire est un traitement, même si l’application ne conserve pas le résultat.

## Points juridiques à valider

### RGPD et secret professionnel

Le RGPD définit les données personnelles comme des informations relatives à une personne identifiée ou identifiable. Le traitement inclut la communication par transmission (articles 4(1) et 4(2), considérant 26). Une adresse postale peut être un identifiant indirect. Ici, l’adresse est reliée à une patiente et peut permettre de distinguer son foyer. Omettre les noms et les identifiants réduit les informations divulguées. Cela ne démontre pas que les données sont anonymes.

Les données relatives aux soins peuvent relever des catégories particulières de données de santé (article 4(15), considérant 35). Il faut déterminer au cas par cas si les lieux transmis, dans leur contexte, relèvent de cette catégorie.

Tout traitement requiert une base juridique au titre de l’article 6. Si des données de santé sont traitées, une exception de l’article 9(2) est également nécessaire. L’article 9(2)(h) peut être pertinent pour certains soins ou la gestion de services de santé, sous les conditions prévues par le droit applicable et l’article 9(3) relatif au secret. Ces conditions sont cumulatives : la finalité de soin ne suffit pas à autoriser automatiquement la transmission à un fournisseur de cartographie.

L’article L.1110-4 du Code de la santé publique encadre le secret professionnel et le partage d’informations au sein de l’équipe de soins. La possibilité de communiquer des lieux à Google et les obligations de transparence, de nécessité et de confidentialité doivent être évaluées par le DPO et le conseil juridique.

### Hébergement de données de santé (HDS)

L’article L.1111-8 du Code de la santé publique prévoit une certification pour l’hébergement de données de santé entrant dans son champ. L’exception de l’article R.1111-8-8 vise certaines opérations ponctuelles. Elle comprend notamment la saisie, la mise en forme et la matérialisation ou dématérialisation. Elle ne mentionne pas expressément le calcul d’itinéraires. Les indications de l’ANS couvrent notamment les plateformes d’hébergement d’applications et l’exploitation de systèmes d’information de santé.

Le service Go ne conserve pas de base de données. Cela ne constitue pas une exemption générale clairement établie. Une analyse factuelle doit examiner le traitement transitoire et l’infrastructure utilisée. Il faut vérifier le périmètre de certification des fournisseurs et des services concernés. Une certification Google Cloud distincte ne permet pas de présumer que Google Maps Platform est couvert.

### Conditions Google Maps Platform

Les conditions applicables dépendent du compte de facturation, de la région et de l’historique de l’intégration. Pour un compte de facturation EEE, les conditions EEE s’appliquent généralement depuis le 8 juillet 2025 aux nouvelles intégrations et à celles modifiées de manière significative. Certaines intégrations antérieures non modifiées peuvent rester sous les conditions standard. Vérifiez le projet, son historique, le revendeur éventuel et tout contrat négocié.

Les restrictions contractuelles Google sont distinctes de la conformité au RGPD : une base juridique n’écarte pas les conditions d’utilisation, et l’autorisation contractuelle ne démontre pas à elle seule la conformité juridique. Les conditions standard (§ 4.4(c)(ii)) interdisent de fournir des données personnelles d’utilisateur final ainsi que les données personnelles d’un utilisateur final européen ; les conditions EEE (§ 4.2) interdisent de fournir des données personnelles d’utilisateur final. Les clauses de localisation (standard § 4.4(c)(iii), EEE § 4.3) prévoient une information préalable et, pour la localisation d’un utilisateur final, un consentement « exprès, préalable et révocable ». L’application étant destinée au personnel, il faut faire confirmer si une patiente est considérée comme un « utilisateur final » au sens du contrat et quelles obligations s’appliquent. Les restrictions HIPAA mentionnées dans ces conditions concernent les données soumises à la loi américaine HIPAA ; elles ne constituent pas une interdiction générale de toute donnée de santé européenne.

Les requêtes de matrice Routes transmettent les lieux d’origine et de destination à Google pour le calcul des durées et distances. Google peut traiter des données de requête comme les adresses, coordonnées et métadonnées techniques selon ses conditions, rôles contractuels, politiques de conservation et règles de transfert applicables. Le fait que les résultats ne soient pas enregistrés par l’application ne contrôle pas le traitement effectué par Google.

Les conditions Maps limitent aussi la mise en cache du contenu Google. Sous réserve des conditions applicables, les conditions Routes permettent de conserver temporairement des latitudes et longitudes jusqu’à 30 jours consécutifs. Elles n’autorisent pas nécessairement la conservation des durées de matrice. L’application n’enregistre pas les résultats Google de façon permanente. Vérifiez tout changement de ce comportement au regard des conditions applicables.

## Vérifications avant un usage réel

Le DPO et le conseil juridique doivent notamment documenter :

1. La base juridique de l’article 6 et, si nécessaire, l’exception de l’article 9, ainsi que la nécessité, la transparence, le secret professionnel et l’opportunité d’une analyse d’impact (AIPD).
2. Les protections du stockage local et des exports, ainsi que la qualification HDS du déploiement et de chacun de ses fournisseurs.
3. Les conditions Google applicables, le statut éventuel de la patiente comme utilisateur final, les obligations relatives aux lieux, les rôles des parties, les transferts et la conservation.
4. La conformité des durées de conservation prévues pour tout résultat de route, en cas de changement du stockage actuel en mémoire.

## Sources principales

- **RGPD :** [Règlement (UE) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng), articles 4, 6 et 9 ; considérants 26 et 35.
- **CNIL :** [Donnée personnelle](https://www.cnil.fr/fr/definition/donnee-personnelle) ; [Donnée de santé](https://www.cnil.fr/fr/sante).
- **Droit français et HDS :** Code de la santé publique, [L.1110-4](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043895798/2026-10-17), [L.1111-8](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000049577902/2026-10-17) et [R.1111-8-8](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000036656709/2026-10-17) ; [certification HDS de l’ANS](https://esante.gouv.fr/produits-services/hds).
- **Google :** [Conditions standard Maps](https://cloud.google.com/maps-platform/terms), [conditions EEE](https://cloud.google.com/terms/maps-platform/eea), [FAQ EEE](https://developers.google.com/maps/comms/eea/faq), [matrice de routes](https://developers.google.com/maps/documentation/routes/compute_route_matrix), [conditions de service Routes EEE](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms), [conditions Routes standard](https://cloud.google.com/maps-platform/terms/maps-service-terms), [règles Routes API](https://developers.google.com/maps/documentation/routes/policies), [conditions responsables de traitement](https://business.safety.google/controllerterms/) et [politique de confidentialité](https://policies.google.com/privacy).
