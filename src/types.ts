export type ManifestEntry =
  | {
      type: "script";
      url: string;
    }
  | {
      type: "zip";
      url: string;
      script?: string;
    };

export type ManifestPermission = {
  id: string;
  title: string;
  description?: string;
  required?: boolean;
};

export type ClientWizardTheme = {
  mode?: "light" | "dark" | "system";
  colors?: {
    background?: string;
    foreground?: string;
    primary?: string;
    primaryForeground?: string;
    secondary?: string;
    secondaryForeground?: string;
    muted?: string;
    mutedForeground?: string;
    accent?: string;
    accentForeground?: string;
    border?: string;
    input?: string;
    ring?: string;
    destructive?: string;
    destructiveForeground?: string;
  };
  radius?: {
    sm?: string;
    md?: string;
    lg?: string;
    xl?: string;
  };
  font?: {
    family?: string;
    headingFamily?: string;
    size?: string;
    headingWeight?: 400 | 500 | 600 | 700;
    bodyWeight?: 400 | 500 | 600;
  };
  spacing?: {
    page?: string;
    surfacePadding?: string;
    sectionGap?: string;
    fieldGap?: string;
    controlHeight?: string;
  };
  layout?: {
    contentWidth?: "full" | "readable" | "compact";
    header?: "none" | "inline" | "sticky";
    alignment?: "start" | "center";
  };
};

export type ClientWizardManifest = {
  name: string;
  description: string;
  version?: string;
  terms?: string[];
  license?: string[];
  privacy?: string[];
  entry: ManifestEntry;
  theme?: ClientWizardTheme;
  permissions: ManifestPermission[];
};

export type NavigationButtonState = "enabled" | "disabled" | "none";

export type MarkdownSurface = {
  id: string;
  kind: "markdown";
  markdown: string;
  storage: Record<string, unknown>;
};

export type WizardStep = {
  id?: string;
  title?: string;
  markdown: string;
  btnPrev?: NavigationButtonState;
  btnNext?: NavigationButtonState;
  btnNextWhen?: string;
};

export type WizardSurface = {
  id: string;
  kind: "wizard";
  currentStep: number;
  steps: WizardStep[];
  storage: Record<string, unknown>;
};

export type ActiveSurface = MarkdownSurface | WizardSurface;

export type DialogDefinition = {
  title?: string;
  text?: string;
  okText?: string;
  cancelText?: string;
  destructive?: boolean;
};

export type NativeCommand =
  | { type: "systemInfo" }
  | { type: "processList" }
  | { type: "runScript"; shell: "powershell" | "bash" | "sh"; script: string; args?: string[] };

export type ExecutorResult = {
  ok: boolean;
  code?: number;
  stdout: string;
  stderr: string;
};
