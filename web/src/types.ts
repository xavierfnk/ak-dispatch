import type { CalculateResponse } from "./response";

export type Parity = "primiparous" | "multiparous";

export interface LocationFields {
  address?: string;
  placeId?: string;
  selectedAddress?: string;
}

export interface Member extends LocationFields {
  id: string;
  name: string;
}

export interface Team {
  id: string;
  name: string;
  members: Member[];
  minPatients: number | null;
  maxPatients: number | null;
}

export interface Capacity {
  minPatients: number | null;
  maxPatients: number | null;
}

export interface CohortTeamOverride {
  enabled?: boolean;
  minPatients?: number | null;
  maxPatients?: number | null;
  disabledMemberIds?: string[];
}

export interface Patient extends LocationFields {
  id: string;
  name: string;
  parity: Parity | "";
  eligiblePec100?: boolean;
}

export interface Cohort {
  id: string;
  expectedDeliveryMonth: string;
  expectedDeliveryHalf: 1 | 2 | 3 | 4;
  periodStart?: number;
  periodEnd?: number;
  revision: number;
  patients: Patient[];
  teamOverrides?: Record<string, CohortTeamOverride>;
}

export interface AppSettings {
  id: "default";
}

export interface RunRecord {
  id: string;
  cohortId: string;
  cohortRevision: number;
  createdAt: string;
  inputKey: string;
  patientNames: Record<string, string>;
  patientParities?: Record<string, Parity>;
  patientPEC100?: Record<string, boolean>;
  teamNames: Record<string, string>;
  teamMemberIds?: Record<string, string[]>;
  memberNames: Record<string, string>;
  result: CalculateResponse;
}

export interface CalculateRequest {
  requestId: string;
  cohort: {
    id: string;
    revision: number;
    expectedDeliveryMonth: string;
    expectedDeliveryHalf: 1 | 2 | 3 | 4;
    patients: Array<{
      id: string;
      location: LocationInput;
      parity: Parity;
      eligiblePec100: boolean;
      eligibleTeamIds?: string[];
    }>;
  };
  teams: Array<{
    id: string;
      minPatients: number;
      maxPatients: number;
      members: Array<{
        id: string;
        location: LocationInput;
    }>;
  }>;
  settings: {
    weights: { capacity: number; geography: number; parity: number };
    referenceTravelTimeMinutes: number;
  };
}

export type LocationInput =
  | { address: string }
  | { placeId: string };
