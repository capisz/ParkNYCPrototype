export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "NYC Parking Planner API",
    version: "1.0.0",
    description: "Advisory, interval-aware NYC parking and pilot trip-planning API. Results never guarantee a physical space."
  },
  servers: [{ url: "/" }],
  paths: {
    "/livez": {
      get: { summary: "Public liveness", responses: { "200": { description: "Process is live" } } }
    },
    "/api/v1/search": {
      get: {
        summary: "Resolve an NYC destination",
        description: "Uses the configured NYC geocoder. Exact reviewed landmark or labeled neighborhood-center aliases may be returned in degraded mode.",
        parameters: [{ name: "text", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 160 } }],
        responses: {
          "200": { description: "GeoJSON destination candidates; degradedMode is true for the curated fallback" },
          "400": { description: "Invalid query" },
          "502": { description: "Geocoder unavailable and no curated match exists" }
        }
      }
    },
    "/api/v1/search/autocomplete": {
      get: {
        summary: "Suggest NYC destinations",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 120 } }],
        responses: {
          "200": { description: "GeoJSON destination suggestions" },
          "400": { description: "Invalid query" },
          "502": { description: "Geocoder unavailable and no curated match exists" }
        }
      }
    },
    "/api/v1/curb/viewport": {
      get: {
        summary: "Interval-aware curb guidance",
        parameters: [...[
          ["minLat", "number"], ["minLng", "number"], ["maxLat", "number"], ["maxLng", "number"],
          ["start", "string"], ["end", "string"]
        ].map(([name, type]) => ({ name, in: "query", required: true, schema: { type, format: name === "start" || name === "end" ? "date-time" : undefined } })), {
          name: "detail", in: "query", required: false,
          schema: { type: "string", enum: ["map", "full"], default: "full" },
          description: "Use map for compact interactive rendering; fetch selected evidence from the curb detail route."
        }],
        responses: {
          "200": { description: "GeoJSON curb classifications", content: { "application/geo+json": { schema: { $ref: "#/components/schemas/Viewport" } } } },
          "400": { description: "Invalid interval or viewport" },
          "503": { description: "Curb guidance safety gate is closed" }
        }
      }
    },
    "/api/v1/curb/{segmentId}": {
      get: {
        summary: "Full interval-aware evidence for one curb feature",
        parameters: [
          { name: "segmentId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "start", in: "query", required: true, schema: { type: "string", format: "date-time" } },
          { name: "end", in: "query", required: true, schema: { type: "string", format: "date-time" } }
        ],
        responses: {
          "200": { description: "Full GeoJSON curb feature including evidence and source metadata" },
          "400": { description: "Invalid identifier or interval" },
          "404": { description: "Curb feature not found" }
        }
      }
    },
    "/api/v1/plans": {
      post: {
        summary: "Plan direct parking or request pilot park-and-ride",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PlanRequest" } } } },
        responses: {
          "200": {
            description: "Advisory parking plan",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PlanResponse" } } }
          },
          "400": { description: "Invalid plan request" }
        }
      }
    },
    "/api/v1/facilities": {
      get: {
        summary: "Active DCWP licensed garage and parking-lot directory",
        parameters: ["lat", "lng", "radius"].map(name => ({ name, in: "query", required: name !== "radius", schema: { type: "number" } })),
        responses: { "200": { description: "Licensed facilities" }, "503": { description: "Facility safety gate is closed" } }
      }
    },
    "/api/v1/hydrants/viewport": {
      get: {
        summary: "Authoritative hydrant points with advisory 15-foot radius buffers",
        description: "Returns NYC DEP hydrant points plus approximate red buffer circles. Buffers are not DOT-validated curb-side extents.",
        parameters: ["minLat", "minLng", "maxLat", "maxLng"].map(name => ({
          name,
          in: "query",
          required: true,
          schema: { type: "number" }
        })),
        responses: {
          "200": { description: "GeoJSON hydrant points and advisory restriction circles" },
          "400": { description: "Invalid viewport" },
          "502": { description: "Hydrant source unavailable" }
        }
      }
    },
    "/api/v1/data-status": {
      get: { summary: "Public source freshness and coverage", responses: { "200": { description: "Dataset status" } } }
    }
  },
  components: {
    schemas: {
      Coordinate: {
        type: "object",
        required: ["latitude", "longitude"],
        properties: { latitude: { type: "number" }, longitude: { type: "number" }, label: { type: "string" } }
      },
      PlanRequest: {
        type: "object",
        required: ["destination", "arriveBy", "leaveAt"],
        properties: {
          origin: { oneOf: [{ $ref: "#/components/schemas/Coordinate" }, { type: "null" }] },
          destination: { $ref: "#/components/schemas/Coordinate" },
          arriveBy: { type: "string", format: "date-time" },
          leaveAt: { type: "string", format: "date-time" },
          preferences: {
            type: "object",
            properties: {
              allowPaid: { type: "boolean" }, includeGarages: { type: "boolean" },
              maxWalkMinutes: { type: "integer", minimum: 5, maximum: 20 },
              transit: { type: "boolean" }, accessibleOnly: { type: "boolean" },
              transitModes: { type: "array", items: { enum: ["SUBWAY", "BUS", "SIR", "LIRR", "METRO_NORTH"] } }
            }
          }
        }
      },
      PlanResponse: {
        type: "object",
        required: ["generatedAt", "expiresAt", "interval", "advisory", "dataVersions", "parkingCalendar", "options", "warnings", "disclaimer"],
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          advisory: { const: true },
          interval: {
            type: "object",
            required: ["start", "end"],
            properties: {
              start: { type: "string", format: "date-time" },
              end: { type: "string", format: "date-time" }
            }
          },
          dataVersions: {
            type: "array",
            items: {
              type: "object",
              required: ["dataset", "datasetId", "version", "sourceUpdatedAt", "state"],
              properties: {
                dataset: { enum: ["geometry", "meters", "signs", "facilities"] },
                datasetId: { type: "string" },
                version: { type: ["string", "null"] },
                sourceUpdatedAt: { type: ["string", "null"], format: "date-time" },
                state: { enum: ["fresh", "stale", "missing", "failed"] }
              }
            }
          },
          parkingCalendar: {
            type: "object",
            required: ["source", "days", "advisory"],
            properties: {
              source: { type: "object" },
              days: {
                type: "array",
                items: {
                  type: "object",
                  required: ["date", "alternateSideParking", "meterRules", "reason", "majorLegalHoliday"],
                  properties: {
                    date: { type: "string", format: "date" },
                    alternateSideParking: { enum: ["in_effect", "suspended", "unknown"] },
                    meterRules: { enum: ["in_effect", "suspended", "unknown"] },
                    reason: { type: "string" },
                    majorLegalHoliday: { type: "boolean" }
                  }
                }
              },
              advisory: { type: "string" }
            }
          },
          options: { type: "array", items: { type: "object" } },
          warnings: {
            type: "array",
            items: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } }
            }
          },
          disclaimer: { type: "string" }
        }
      },
      Viewport: {
        type: "object",
        required: ["type", "interval", "summary", "features", "advisory"],
        properties: {
          type: { const: "FeatureCollection" },
          advisory: { const: true },
          interval: { type: "object", properties: { start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" } } },
          summary: {
            type: "object",
            properties: {
              cannotPark: { type: "integer" }, paid: { type: "integer" },
              free: { type: "integer" }, unknown: { type: "integer" }
            }
          },
          features: { type: "array", items: { type: "object" } }
        }
      },
      ParkingStatus: { enum: ["cannot_park", "paid", "free", "unknown"] }
    }
  }
} as const;
