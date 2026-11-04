import type { AppSettings, Cohort, Team } from "./types";

const id = () => crypto.randomUUID();

export function syntheticDemo(): { teams: Team[]; cohort: Cohort; settings: AppSettings } {
  const teams: Team[] = [
    {
      id: id(),
      name: "Équipe A",
      minPatients: 3,
      maxPatients: 5,
      members: [
        { id: id(), name: "Sage-femme A1", address: "Place d'Italie, Paris", placeId: "" },
        { id: id(), name: "Sage-femme A2", address: "Gare Montparnasse, Paris", placeId: "" },
      ],
    },
    {
      id: id(),
      name: "Équipe B",
      minPatients: 3,
      maxPatients: 5,
      members: [
        { id: id(), name: "Sage-femme B1", address: "Gare de Lyon, Paris", placeId: "" },
        { id: id(), name: "Sage-femme B2", address: "Place de la Bastille, Paris", placeId: "" },
      ],
    },
    {
      id: id(),
      name: "Équipe C",
      minPatients: 3,
      maxPatients: 6,
      members: [
        { id: id(), name: "Sage-femme C1", address: "Porte de la Chapelle, Paris", placeId: "" },
        { id: id(), name: "Sage-femme C2", address: "Parc de la Villette, Paris", placeId: "" },
      ],
    },
  ];
  const parity = [
    "primiparous", "multiparous", "primiparous", "multiparous",
    "multiparous", "primiparous", "multiparous", "primiparous",
    "primiparous", "multiparous", "primiparous", "multiparous",
  ] as const;
  const addresses = [
    "Place d'Italie, Paris", "Place de la République, Paris", "Gare d'Austerlitz, Paris", "Place de la Nation, Paris",
    "Parc Montsouris, Paris", "Place de la Bastille, Paris", "Jardin des Plantes, Paris", "Parc de la Villette, Paris",
    "Gare du Nord, Paris", "Place de Clichy, Paris", "Place des Vosges, Paris", "Gare Montparnasse, Paris",
  ];
  const cohort: Cohort = {
    id: id(),
    expectedDeliveryMonth: "2027-04",
    expectedDeliveryHalf: 1,
    revision: 1,
    patients: addresses.map((address, index) => ({
      id: id(),
      name: `Patiente ${String(index + 1).padStart(2, "0")}`,
      address,
      placeId: "",
      parity: parity[index],
    })),
  };
  const settings: AppSettings = { id: "default" };
  return { teams, cohort, settings };
}
