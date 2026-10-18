export interface SupportProvider {
  name: string;
  label: string;
  url?: string;
}

// Add the public profile URLs when these sponsorship pages are ready.
export const supportProviders: SupportProvider[] = [
  {
    name: "Ko-fi",
    label: "Halte FoldRoute am Rollen 💛",
    url: "https://ko-fi.com/lars147",
  },
  { name: "GitHub Sponsors", label: "GitHub Sponsors", url: undefined },
];
