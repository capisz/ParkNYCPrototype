import Foundation
import MapKit
import CoreLocation

final class GarageSearchService {
    func fetchGarages(
        near coordinate: CLLocationCoordinate2D,
        searchRadiusMeters: CLLocationDistance = 2200,
        limit: Int = 30
    ) async throws -> [GarageOption] {
        async let garageResults = search(query: "parking garage", near: coordinate, searchRadiusMeters: searchRadiusMeters)
        async let lotResults = search(query: "parking lot", near: coordinate, searchRadiusMeters: searchRadiusMeters)

        let combined = try await garageResults + lotResults
        let deduped = dedupe(combined)
        return Array(deduped.prefix(limit))
    }

    private func search(
        query: String,
        near coordinate: CLLocationCoordinate2D,
        searchRadiusMeters: CLLocationDistance
    ) async throws -> [GarageOption] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.region = MKCoordinateRegion(
            center: coordinate,
            latitudinalMeters: searchRadiusMeters,
            longitudinalMeters: searchRadiusMeters
        )
        request.resultTypes = .pointOfInterest
        request.pointOfInterestFilter = MKPointOfInterestFilter(including: [.parking])

        let response = try await MKLocalSearch(request: request).start()
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        return response.mapItems.compactMap { item in
            let coord = self.coordinate(for: item)
            guard CLLocationCoordinate2DIsValid(coord) else { return nil }

            let target = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
            let distance = center.distance(from: target)

            let name = item.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanedName = (name?.isEmpty == false ? name! : "Parking")
            let address = compactAddress(for: item)

            return GarageOption(
                name: cleanedName,
                address: address,
                coordinate: coord,
                distanceMeters: distance,
                phoneNumber: item.phoneNumber
            )
        }
        .sorted { $0.distanceMeters < $1.distanceMeters }
    }

    private func coordinate(for item: MKMapItem) -> CLLocationCoordinate2D {
        if item.responds(to: NSSelectorFromString("location")),
           let location = item.value(forKey: "location") as? CLLocation {
            return location.coordinate
        }
        return CLLocationCoordinate2D(latitude: 0, longitude: 0)
    }

    private func compactAddress(for item: MKMapItem) -> String {
        if item.responds(to: NSSelectorFromString("addressRepresentations")),
           let reps = item.value(forKey: "addressRepresentations") {
            let fullSelector = NSSelectorFromString("fullAddressIncludingRegion:singleLine:")
            if let repsObj = reps as? NSObject,
               repsObj.responds(to: fullSelector),
               let unmanaged = repsObj.perform(fullSelector, with: NSNumber(value: true), with: NSNumber(value: true)),
               let fullAddress = unmanaged.takeUnretainedValue() as? String {
                let cleaned = fullAddress
                    .replacingOccurrences(of: "\n", with: ", ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleaned.isEmpty {
                    return cleaned
                }
            }

            if let repsObj = reps as? NSObject {
                let city = repsObj.value(forKey: "cityName") as? String
                let region = repsObj.value(forKey: "regionName") as? String
                let parts = [city, region]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                if !parts.isEmpty {
                    return parts.joined(separator: ", ")
                }
            }
        }
        if item.responds(to: NSSelectorFromString("address")),
           let address = item.value(forKey: "address") {
            let cleaned = String(describing: address).trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty {
                return cleaned
            }
        }
        if let title = item.name?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            return title
        }
        return "Address unavailable"
    }

    private func dedupe(_ items: [GarageOption]) -> [GarageOption] {
        var seen = Set<String>()
        var result: [GarageOption] = []
        result.reserveCapacity(items.count)

        for item in items {
            if seen.insert(item.id).inserted {
                result.append(item)
            }
        }

        return result.sorted { $0.distanceMeters < $1.distanceMeters }
    }
}
