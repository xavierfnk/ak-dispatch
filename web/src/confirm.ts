export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "import-dialog";
    dialog.setAttribute("aria-labelledby", "confirmation-message");
    const form = document.createElement("form");
    form.method = "dialog";
    const text = document.createElement("p");
    text.id = "confirmation-message";
    text.textContent = message;
    const actions = document.createElement("div");
    actions.className = "api-key-actions";
    const cancel = document.createElement("button");
    cancel.className = "button button-quiet";
    cancel.value = "cancel";
    cancel.textContent = "Annuler";
    cancel.autofocus = true;
    const confirm = document.createElement("button");
    confirm.className = "button button-primary";
    confirm.value = "confirm";
    confirm.textContent = "Confirmer";
    actions.append(cancel, confirm);
    form.append(text, actions);
    dialog.append(form);
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
