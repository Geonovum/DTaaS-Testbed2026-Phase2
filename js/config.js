var respecConfig =
{
  useLogo: true,
  useLabel: true,
  title: "DTaaS Testbed2026 Phase 2",
  subtitle: "Engineering Report",
  specStatus: "wv",
  specType: "HR",
  license: "cc-by",
  pubdomain: "nldt",
  shortName: "dtaastestbed2026phase2",
  maxTocLevel: 3,
//   publishDate: "2024-06-21",
  publishVersion: "0.8.0",
  thisVersion: [
    "https://geonovum.github.io/DTaaS-Testbed2026-Phase2"
  ],
  github: "https://github.com/geonovum/DTaaS-Testbed2026-Phase2/",
  postProcess: [
    ...(organisationConfig.postProcess ?? []),
    localizeGitHubHeaderLinks
  ],
  issueBase: "https://github.com/geonovum/DTaaS-Testbed2026-Phase2/issues/",
  edDraftURI: "https://geonovum.github.io/DTaaS-Testbed2026-Phase2",
  authors: [
    {
      name: "Bart De Lathouwer",
      company: "Geonovum",
      companyURL: "https://www.geonovum.nl/"
    },
    {
      name: "Niels Hoffmann",
      company: "Geonovum",
      companyURL: "https://www.geonovum.nl/"
    },
    {name: "uCrowds"},
    {name: "Annivizion"},
    {name: "The People Group"},
    {name: "Collaboral"},
    {name: "Varidian"},
    {name: "Future Insight"},
    {name: "Gérald Fenoy",
    company: "GeoLabs SARL",
    companyURL: "https://www.geolabs.fr"
    }

  ],
  editors: [
    {
      name: "Niels Hoffmann",
      company: "Geonovum",
      companyURL: "https://www.geonovum.nl/"
    }
  ],

  localBiblio: {
        
    NLDT: {
      title: "Referentie Architectuur NLDT",
      href: "https://geonovum.github.io/NLDT-Architectuur/",
      publisher: "Geonovum"
  }
  }
};


function localizeGitHubHeaderLinks(_config, document) {
  if (document.documentElement.lang !== "nl") {
    return;
  }

  const issueLink = document.querySelector(
    '.head dl a[href$="/issues/"], .head dl a[href$="/issues"]'
  );
  if (issueLink) {
    issueLink.textContent = "Alle issues";
  }
}
