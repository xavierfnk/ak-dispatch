import { useState, type FormEvent } from "react";
import { removeGoogleApiKey, saveGoogleApiKey } from "./apiKey";
import { confirmAction } from "./confirm";

interface GoogleApiKeySettingsProps {
  configured: boolean;
  onChange: (configured: boolean) => void;
}

export function GoogleApiKeySettings({ configured, onChange }: GoogleApiKeySettingsProps) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      saveGoogleApiKey(apiKey);
      setApiKey("");
      onChange(true);
      setMessage("La clé a été enregistrée dans ce navigateur.");
    } catch {
      setMessage("La clé n’a pas pu être enregistrée dans ce navigateur.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirmAction("Supprimer la clé Google Maps enregistrée dans ce navigateur ?"))) return;
    setBusy(true);
    setMessage("");
    try {
      removeGoogleApiKey();
      onChange(false);
      setMessage("La clé a été supprimée.");
    } catch {
      setMessage("La clé n’a pas pu être supprimée de ce navigateur.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel api-key-panel" aria-labelledby="google-api-key-heading">
      <div className="panel-heading">
        <div><span className="eyebrow">CALCUL DES TRAJETS</span><h3 id="google-api-key-heading">Clé Google Maps</h3></div>
        <span className={`status-pill ${configured ? "status-optimal" : "status-needs_review"}`}>{configured ? "Configurée" : "À configurer"}</span>
      </div>
      <p className="section-hint">Chaque utilisateur fournit sa propre clé et active l’API Routes. L’application envoie les lieux à Google uniquement lors du calcul des trajets.</p>
      <form className="api-key-form" onSubmit={(event) => void save(event)}>
        <label className="field-label" htmlFor="google-api-key">Clé API personnelle
          <input
            id="google-api-key"
            type="password"
            autoComplete="new-password"
            maxLength={512}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={configured ? "Saisir une nouvelle clé pour la remplacer" : "Coller la clé API"}
          />
        </label>
        <div className="api-key-actions">
          <button className="button button-primary" type="submit" disabled={busy || !apiKey.trim()}>{busy ? "Enregistrement…" : "Enregistrer la clé"}</button>
          {configured && <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove()}>Supprimer la clé</button>}
        </div>
      </form>
      {message && <p className="section-hint" role="status">{message}</p>}
      <p className="section-hint">La clé est conservée dans le stockage local de ce navigateur. Elle n’est pas incluse dans les exports. Toute personne ayant accès à ce navigateur peut la lire : restreignez-la à l’API Routes et aux origines autorisées dans Google Cloud.</p>
    </section>
  );
}
