/** Trade-off pillar metadata for Blackboxes engine models (generated from BlackBoxes shared/model-core.js definitions). */
export interface Pillar { label: string; unit: string; def: number; min: number; max: number }
export const PILLARS: Record<string, Record<string, Pillar>> = {
  "boxem": {
    "time": {
      "label": "Time",
      "unit": "weeks",
      "def": 4,
      "min": 0.5,
      "max": 520
    },
    "cost": {
      "label": "Budget",
      "unit": "USD",
      "def": 8500,
      "min": 0,
      "max": 1000000000
    },
    "quality": {
      "label": "Quality",
      "unit": "%",
      "def": 88,
      "min": 10,
      "max": 200
    },
    "scope": {
      "label": "Scope",
      "unit": "%",
      "def": 100,
      "min": 10,
      "max": 250
    },
    "rate": {
      "label": "Base rate",
      "unit": "USD/hour",
      "def": 110,
      "min": 10,
      "max": 2000
    },
    "floor": {
      "label": "Full-scope floor",
      "unit": "USD",
      "def": 7500,
      "min": 0,
      "max": 1000000000
    }
  },
  "orbitem": {
    "budget": {
      "label": "Monthly budget",
      "unit": "USD/month",
      "def": 450,
      "min": 50,
      "max": 500000
    },
    "sla": {
      "label": "Availability (SLA)",
      "unit": "%",
      "def": 99.9,
      "min": 90,
      "max": 99.999
    },
    "latency": {
      "label": "P99 latency",
      "unit": "ms",
      "def": 45,
      "min": 1,
      "max": 2000
    },
    "compute": {
      "label": "Compute capacity",
      "unit": "capacity index",
      "def": 100,
      "min": 10,
      "max": 500
    },
    "complexity": {
      "label": "Ops complexity",
      "unit": "index",
      "def": 35,
      "min": 10,
      "max": 250
    },
    "security": {
      "label": "Security compliance",
      "unit": "scenario index",
      "def": 75,
      "min": 50,
      "max": 100
    }
  },
  "pulseem": {
    "strain": {
      "label": "Training strain",
      "unit": "TRIMP",
      "def": 380,
      "min": 50,
      "max": 1500
    },
    "recovery": {
      "label": "Recovery (HRV)",
      "unit": "ms",
      "def": 85,
      "min": 10,
      "max": 200
    },
    "fuel": {
      "label": "Metabolic fuelling",
      "unit": "%",
      "def": 100,
      "min": 20,
      "max": 200
    },
    "autophagy": {
      "label": "Autophagy score",
      "unit": "illustrative index",
      "def": 100,
      "min": 20,
      "max": 160
    },
    "longevity": {
      "label": "Longevity score",
      "unit": "illustrative index",
      "def": 125,
      "min": 10,
      "max": 150
    }
  },
  "capem": {
    "capital": {
      "label": "Capital raised",
      "unit": "USD",
      "def": 750000,
      "min": 10000,
      "max": 100000000
    },
    "valuation": {
      "label": "Post-money valuation",
      "unit": "USD",
      "def": 7500000,
      "min": 500000,
      "max": 500000000
    },
    "runway": {
      "label": "Runway",
      "unit": "months",
      "def": 18,
      "min": 0.1,
      "max": 120
    },
    "esop": {
      "label": "ESOP pool",
      "unit": "%",
      "def": 10,
      "min": 0,
      "max": 100
    },
    "founder": {
      "label": "Founder equity",
      "unit": "%",
      "def": 80,
      "min": 0,
      "max": 100
    },
    "burn": {
      "label": "Monthly burn",
      "unit": "USD/month",
      "def": 41666.666666666664,
      "min": 1,
      "max": 100000000
    }
  },
  "synthem": {
    "drive": {
      "label": "Harmonic drive",
      "unit": "%",
      "def": 75,
      "min": 0,
      "max": 100
    },
    "crest": {
      "label": "Dynamic crest",
      "unit": "dB",
      "def": 14,
      "min": 1,
      "max": 30
    },
    "pitch": {
      "label": "Pitch ratio",
      "unit": "ratio",
      "def": 0.85,
      "min": 0.25,
      "max": 4
    },
    "reverb": {
      "label": "Reverb decay",
      "unit": "seconds",
      "def": 0.8,
      "min": 0.1,
      "max": 12
    },
    "cutoff": {
      "label": "Filter cutoff",
      "unit": "Hz",
      "def": 1800,
      "min": 100,
      "max": 12000
    },
    "width": {
      "label": "Stereo width",
      "unit": "%",
      "def": 65,
      "min": 0,
      "max": 100
    }
  },
  "balancem": {
    "dps": {
      "label": "Damage per second",
      "unit": "damage/second",
      "def": 780,
      "min": 10,
      "max": 5000
    },
    "ehp": {
      "label": "Effective health",
      "unit": "EHP",
      "def": 18500,
      "min": 100,
      "max": 50000
    },
    "resource": {
      "label": "Resource cost",
      "unit": "cost index",
      "def": 85,
      "min": 5,
      "max": 250
    },
    "skill": {
      "label": "Skill ceiling",
      "unit": "actions/minute",
      "def": 90,
      "min": 20,
      "max": 400
    },
    "mobility": {
      "label": "Mobility",
      "unit": "units/second",
      "def": 50,
      "min": 10,
      "max": 120
    },
    "crit": {
      "label": "Critical multiplier",
      "unit": "ratio",
      "def": 1.5,
      "min": 1,
      "max": 4
    }
  }
}
