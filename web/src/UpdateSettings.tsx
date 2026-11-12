import { useState } from "react";
import { PlannerService } from "../../server/cmd/desktop/frontend/bindings/patient-dispatch-planner/server/cmd/desktop";
import { confirmAction } from "./confirm";

type UpdateStatus = Awaited<ReturnType<typeof PlannerService.CheckForUpdate>>;

export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function check() {
    setBusy(true);
    setMessage("");
    try {
      const result = await PlannerService.CheckForUpdate();
      setStatus(result);
      setMessage(result.Pending
        ? `La version ${result.LatestVersion} est en cours de préparation pour votre plateforme. Réessayez plus tard.`
        : result.Available
        ? `La version ${result.LatestVersion} est disponible.`
        : `L’application est à jour (${result.CurrentVersion}).`);
    } catch {
      setStatus(null);
      setMessage("La recherche de mise à jour a échoué. Vérifiez votre connexion. Vérifiez aussi qu’une version stable est publiée.");
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!(await confirmAction(`Installer la version ${status?.LatestVersion} et redémarrer l’application ?`))) return;
    setBusy(true);
    setMessage("Téléchargement et vérification de la mise à jour…");
    try {
      await PlannerService.InstallUpdate();
    } catch {
      setMessage("La mise à jour n’a pas pu être préparée. Vérifiez votre connexion et les droits du dossier d’installation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel api-key-panel" aria-labelledby="updates-heading">
      <div className="panel-heading">
        <div><span className="eyebrow">APPLICATION</span><h3 id="updates-heading">Mises à jour</h3></div>
      </div>
      <p className="section-hint">L’application contacte GitHub uniquement lorsque vous recherchez une mise à jour. Elle n’envoie aucune donnée de patiente, d’équipe ou de planification.</p>
      <div className="api-key-actions">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => void check()}>
          {busy && !status?.Available ? "Vérification…" : "Rechercher une mise à jour"}
        </button>
        {status?.Available && status.Installed && (
          <button className="button button-primary" type="button" disabled={busy} onClick={() => void install()}>
            Installer et redémarrer
          </button>
        )}
      </div>
      {status?.Available && !status.Installed && (
        <p className="section-hint" role="status">Pour installer une mise à jour, placez d’abord l’application dans : {status.InstallPath}</p>
      )}
      {message && <p className="section-hint" role="status">{message}</p>}
    </section>
  );
}
