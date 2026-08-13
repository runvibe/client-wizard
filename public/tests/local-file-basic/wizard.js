const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "intro",
        title: "Local manifest",
        markdown: "# Local manifest loaded\n\nThis wizard.js file was resolved relative to the selected manifest file."
      },
      {
        id: "system",
        title: "System",
        markdown:
          "## System information\n\nStatus: `{{ storage.status }}`\n\nOS: `{{ storage.os }}`\n\nArchitecture: `{{ storage.arch }}`"
      }
    ]
  },
  { storage: { status: "waiting" } }
);

wizard.events(async (event) => {
  if (event.type !== "next" || event.data.index !== 1) {
    return;
  }

  await wizard.setStorage({ status: "reading system information" });
  const result = await clientWizard.invoke({ type: "systemInfo" });
  const system = JSON.parse(result.stdout || "{}");
  await wizard.setStorage({
    status: "complete",
    os: system.os || "unknown",
    arch: system.cpuArchitecture || "unknown"
  });
});
