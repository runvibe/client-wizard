(function () {
  const callbacks = new Map();

  function request(type, payload, callback) {
    const id = crypto.randomUUID();

    if (callback) {
      callbacks.set(id, callback);
    }

    window.parent.postMessage(
      {
        source: "client-wizard-page",
        type,
        id,
        ...payload,
      },
      "*"
    );

    return new Promise((resolve, reject) => {
      function onMessage(event) {
        if (event.data?.source !== "client-wizard-host" || event.data?.id !== id || event.data?.type === "ui-event") {
          return;
        }

        window.removeEventListener("message", onMessage);
        if (event.data.error) {
          reject(new Error(event.data.error));
          return;
        }

        resolve(event.data.result);
      }

      window.addEventListener("message", onMessage);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.data?.source !== "client-wizard-host" || event.data?.type !== "ui-event") {
      return;
    }

    callbacks.get(event.data.id)?.(event.data.eventName, event.data.data);
  });

  window.clientWizard = {
    invoke(command) {
      return request("native-command", { command });
    },
    useMarkdown(markdownOrOptions, callback) {
      const options = typeof markdownOrOptions === "string" ? { markdown: markdownOrOptions } : markdownOrOptions;
      return request("render-markdown", options ?? {}, callback);
    },
    useWizard(wizard, callback) {
      return request("render-wizard", { wizard }, callback);
    },
    progressive(name, value) {
      return request("progressive", { name, value });
    },
    clear() {
      return request("clear-surface", {});
    },
  };
})();
