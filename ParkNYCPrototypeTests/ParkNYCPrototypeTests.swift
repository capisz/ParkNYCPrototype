//
//  ParkNYCPrototypeTests.swift
//  ParkNYCPrototypeTests
//
//  Created by NYCDOE on 12/27/25.
//

import Foundation
import CoreLocation
import Testing
@testable import NYC_Parking_Planner

@MainActor
struct ParkNYCPrototypeTests {

    @Test func recommendationPayloadDecodesIntervalSafetyFields() throws {
        let json = #"""
        {
          "generatedAt": "2026-07-17T16:00:00.000Z",
          "expiresAt": "2026-07-17T16:05:00.000Z",
          "interval": {
            "start": "2026-07-17T19:00:00.000Z",
            "end": "2026-07-17T21:00:00.000Z"
          },
          "timezone": "America/New_York",
          "availability": { "cannotPark": 4, "paid": 12, "free": 7, "unknown": 3 },
          "options": [{
            "id": "curb-101",
            "kind": "curb",
            "tier": "free",
            "status": "free",
            "title": "West 34 Street",
            "subtitle": "5 Avenue to 6 Avenue",
            "latitude": 40.7484,
            "longitude": -73.9857,
            "distanceMeters": 180,
            "walkMinutes": 3,
            "confidence": 0.86,
            "coverage": "full",
            "score": 15.5,
            "ruleSummary": "The complete selected interval is resolved as free.",
            "nextChange": "2026-07-17T20:00:00.000Z",
            "sourceVersion": "signs-run-101",
            "facility": null,
            "transit": null
          }],
          "warnings": [],
          "disclaimer": "Verify posted signs before parking."
        }
        """#

        let payload = try JSONDecoder().decode(
            ParkingRecommendationResponse.self,
            from: Data(json.utf8)
        )

        #expect(payload.availability.free == 7)
        #expect(payload.availability.paid == 12)
        #expect(payload.availability.cannotPark == 4)
        #expect(payload.options.count == 1)
        #expect(payload.options[0].tierLabel == "Free curb")
        #expect(payload.options[0].coordinate.latitude == 40.7484)
        #expect(payload.options[0].confidence == 0.86)
        #expect(payload.options[0].coverage == "full")
        #expect(payload.interval.end == "2026-07-17T21:00:00.000Z")
    }

    @Test func curbStatusKeepsUnknownDistinctFromFree() {
        #expect(ParkingStatus.unknown.title == "Unknown — check signs")
        #expect(ParkingStatus.legalNow.title == "Free parking")
        #expect(ParkingStatus.illegalNow.title == "Cannot park")
        #expect(ParkingStatus.unknown != ParkingStatus.legalNow)
    }

    @Test func recommendationPreferencesPreservePilotChoices() {
        let preferences = ParkingRecommendationPreferences(
            allowPaid: false,
            allowGarages: true,
            maxWalkMinutes: 15,
            allowTransit: true,
            accessibleOnly: true
        )

        #expect(preferences.allowPaid == false)
        #expect(preferences.allowGarages)
        #expect(preferences.maxWalkMinutes == 15)
        #expect(preferences.allowTransit)
        #expect(preferences.accessibleOnly)
    }

}
