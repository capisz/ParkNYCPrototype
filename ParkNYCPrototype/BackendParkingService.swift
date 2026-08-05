import Foundation
import CoreLocation
import MapKit

enum BackendParkingError: LocalizedError {
    case invalidURL
    case badStatusCode(Int)
    case deviceLoopbackHost(String)
    case configurationMissing

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Backend URL is invalid."
        case .badStatusCode(let statusCode):
            return "Backend returned HTTP \(statusCode)."
        case .deviceLoopbackHost(let hostURL):
            return "Backend URL \(hostURL) is loopback. On a physical iPhone, use your Mac LAN IP."
        case .configurationMissing:
            return "A secure NYC Parking Planner backend URL is required for this build."
        }
    }
}

final class BackendParkingService {
    private let session: URLSession
    private let baseURL: URL
    private let hasRuntimeConfiguration: Bool
    private let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(
        session: URLSession = .shared,
        baseURLString: String? = Bundle.main.object(forInfoDictionaryKey: "ParkingBackendBaseURL") as? String
    ) {
        self.session = session

        let configured = baseURLString?.trimmingCharacters(in: .whitespacesAndNewlines)
#if DEBUG
        let fallback = "http://127.0.0.1:8080"
#else
        let fallback = "https://configuration-required.invalid"
#endif
        let selected = (configured?.isEmpty == false && configured?.contains("$(") == false ? configured : nil) ?? fallback
        self.baseURL = URL(string: selected) ?? URL(string: fallback)!
        self.hasRuntimeConfiguration = selected != "https://configuration-required.invalid"
    }

    func fetchSegments(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int = 900,
        start: Date,
        end: Date
    ) async throws -> [CurbSegment] {
        let bbox = BoundingBox(center: coordinate, radiusMeters: Double(radiusMeters))
        let fetched = try await fetchSegments(
            in: bbox,
            sortedNear: coordinate,
            proximityRadiusMeters: radiusMeters,
            approximateZoom: approximateZoom(for: radiusMeters),
            start: start,
            end: end
        )
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        return fetched.filter { segment in
            let segmentMidpoint = midpoint(of: segment.coordinates)
            let segmentLocation = CLLocation(latitude: segmentMidpoint.latitude, longitude: segmentMidpoint.longitude)
            return center.distance(from: segmentLocation) <= Double(radiusMeters)
        }
    }

    func fetchRecommendations(
        near coordinate: CLLocationCoordinate2D,
        arrival: Date,
        departure: Date,
        preferences: ParkingRecommendationPreferences
    ) async throws -> ParkingRecommendationResponse {
        try validateRuntimeConfiguration()
        if shouldRejectLoopbackOnDevice(baseURL: baseURL) {
            throw BackendParkingError.deviceLoopbackHost(baseURL.absoluteString)
        }

        var request = URLRequest(url: plansURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(BackendPlanRequest(
            origin: nil,
            destination: BackendPlanCoordinate(
                latitude: coordinate.latitude,
                longitude: coordinate.longitude,
                label: nil
            ),
            arriveBy: iso8601.string(from: arrival),
            leaveAt: iso8601.string(from: departure),
            preferences: BackendPlanPreferences(
                allowPaid: preferences.allowPaid,
                includeGarages: preferences.allowGarages,
                maxWalkMinutes: preferences.maxWalkMinutes,
                transit: preferences.allowTransit,
                accessibleOnly: preferences.accessibleOnly,
                transitModes: ["SUBWAY", "BUS", "SIR", "LIRR", "METRO_NORTH"]
            )
        ))
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BackendParkingError.badStatusCode(-1)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw BackendParkingError.badStatusCode(httpResponse.statusCode)
        }
        return try JSONDecoder().decode(ParkingRecommendationResponse.self, from: data)
    }

    func fetchHydrantCoordinates(in region: MKCoordinateRegion) async throws -> [CLLocationCoordinate2D] {
        try validateRuntimeConfiguration()
        if shouldRejectLoopbackOnDevice(baseURL: baseURL) {
            throw BackendParkingError.deviceLoopbackHost(baseURL.absoluteString)
        }

        let bounds = BoundingBox(region: region)
        guard var components = URLComponents(url: hydrantsURL, resolvingAgainstBaseURL: false) else {
            throw BackendParkingError.invalidURL
        }
        components.queryItems = [
            URLQueryItem(name: "minLat", value: decimalText(bounds.minLat)),
            URLQueryItem(name: "minLng", value: decimalText(bounds.minLng)),
            URLQueryItem(name: "maxLat", value: decimalText(bounds.maxLat)),
            URLQueryItem(name: "maxLng", value: decimalText(bounds.maxLng))
        ]
        guard let url = components.url else {
            throw BackendParkingError.invalidURL
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BackendParkingError.badStatusCode(-1)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw BackendParkingError.badStatusCode(httpResponse.statusCode)
        }

        let payload = try JSONDecoder().decode(BackendHydrantResponse.self, from: data)
        return payload.features.compactMap(\.pointCoordinate)
    }

    func fetchLicensedFacilities(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int = 1_500
    ) async throws -> [GarageOption] {
        try validateRuntimeConfiguration()
        if shouldRejectLoopbackOnDevice(baseURL: baseURL) {
            throw BackendParkingError.deviceLoopbackHost(baseURL.absoluteString)
        }
        guard var components = URLComponents(url: facilitiesURL, resolvingAgainstBaseURL: false) else {
            throw BackendParkingError.invalidURL
        }
        components.queryItems = [
            URLQueryItem(name: "lat", value: decimalText(coordinate.latitude)),
            URLQueryItem(name: "lng", value: decimalText(coordinate.longitude)),
            URLQueryItem(name: "radius", value: String(radiusMeters))
        ]
        guard let url = components.url else { throw BackendParkingError.invalidURL }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BackendParkingError.badStatusCode(-1)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw BackendParkingError.badStatusCode(httpResponse.statusCode)
        }
        let payload = try JSONDecoder().decode(BackendFacilitiesResponse.self, from: data)
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        return payload.facilities.map { facility in
            let facilityCoordinate = CLLocationCoordinate2D(latitude: facility.latitude, longitude: facility.longitude)
            let distance = center.distance(from: CLLocation(latitude: facility.latitude, longitude: facility.longitude))
            return GarageOption(
                name: facility.name,
                address: facility.address,
                coordinate: facilityCoordinate,
                distanceMeters: distance,
                phoneNumber: facility.phone,
                licenseNumber: facility.licenseNumber,
                licenseStatus: facility.licenseStatus,
                licenseExpiresAt: facility.licenseExpiresAt
            )
        }
        .sorted { $0.distanceMeters < $1.distanceMeters }
    }

    func fetchSegments(
        in region: MKCoordinateRegion,
        start: Date,
        end: Date
    ) async throws -> [CurbSegment] {
        let bbox = BoundingBox(region: region)
        return try await fetchSegments(
            in: bbox,
            sortedNear: region.center,
            proximityRadiusMeters: nil,
            approximateZoom: nil,
            start: start,
            end: end
        )
    }

    private func fetchSegments(
        in bbox: BoundingBox,
        sortedNear coordinate: CLLocationCoordinate2D,
        proximityRadiusMeters: Int?,
        approximateZoom: Double?,
        start: Date,
        end: Date
    ) async throws -> [CurbSegment] {
        try validateRuntimeConfiguration()
        if shouldRejectLoopbackOnDevice(baseURL: baseURL) {
            throw BackendParkingError.deviceLoopbackHost(baseURL.absoluteString)
        }

        guard var components = URLComponents(url: viewportURL, resolvingAgainstBaseURL: false) else {
            throw BackendParkingError.invalidURL
        }

        var queryItems = [
            URLQueryItem(name: "minLat", value: decimalText(bbox.minLat)),
            URLQueryItem(name: "minLng", value: decimalText(bbox.minLng)),
            URLQueryItem(name: "maxLat", value: decimalText(bbox.maxLat)),
            URLQueryItem(name: "maxLng", value: decimalText(bbox.maxLng)),
            URLQueryItem(name: "start", value: iso8601.string(from: start)),
            URLQueryItem(name: "end", value: iso8601.string(from: end))
        ]
        if let proximityRadiusMeters, let approximateZoom {
            queryItems.append(contentsOf: [
                URLQueryItem(name: "centerLat", value: decimalText(coordinate.latitude)),
                URLQueryItem(name: "centerLng", value: decimalText(coordinate.longitude)),
                URLQueryItem(name: "radiusMeters", value: String(proximityRadiusMeters)),
                URLQueryItem(name: "zoom", value: decimalText(approximateZoom))
            ])
        }
        components.queryItems = queryItems

        guard let url = components.url else {
            throw BackendParkingError.invalidURL
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BackendParkingError.badStatusCode(-1)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw BackendParkingError.badStatusCode(httpResponse.statusCode)
        }

        let decoder = JSONDecoder()
        let payload = try decoder.decode(BackendViewportResponse.self, from: data)
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        return payload.features.compactMap { feature in
            mapFeature(feature)
        }
        .sorted { lhs, rhs in
            let leftMid = midpoint(of: lhs.coordinates)
            let rightMid = midpoint(of: rhs.coordinates)
            let leftDistance = center.distance(from: CLLocation(latitude: leftMid.latitude, longitude: leftMid.longitude))
            let rightDistance = center.distance(from: CLLocation(latitude: rightMid.latitude, longitude: rightMid.longitude))
            return leftDistance < rightDistance
        }
    }

    private var viewportURL: URL {
        return baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("curb")
            .appendingPathComponent("viewport")
    }

    private var plansURL: URL {
        baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("plans")
    }

    private var hydrantsURL: URL {
        baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("hydrants")
            .appendingPathComponent("viewport")
    }

    private var facilitiesURL: URL {
        baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("facilities")
    }

    private func approximateZoom(for radiusMeters: Int) -> Double {
        let radius = max(120, min(1200, radiusMeters))
        return max(15.5, min(22, 16 + log2(1200 / Double(radius))))
    }

    private func mapFeature(_ feature: BackendFeature) -> CurbSegment? {
        let coordinates = feature.geometry.coordinates
        guard coordinates.count >= 2 else { return nil }

        let status = mapStatus(feature.properties.status)
        let onStreet = feature.properties.onStreet?.trimmedNonEmpty
        let fromStreet = feature.properties.fromStreet?.trimmedNonEmpty
        let toStreet = feature.properties.toStreet?.trimmedNonEmpty
        let sideOfStreet = feature.properties.sideOfStreet?.trimmedNonEmpty

        let name: String
        if let onStreet {
            let sideText = sideOfStreet ?? "?"
            let fromText = fromStreet ?? "Unknown"
            let toText = toStreet ?? "Unknown"
            name = "\(onStreet) (\(sideText)) • \(fromText) to \(toText)"
        } else {
            name = feature.properties.blockfaceKey?.trimmedNonEmpty ?? "NYC curb segment"
        }

        let explanation = feature.properties.ruleSummary?.trimmedNonEmpty ?? defaultExplanation(for: status)
        let rateText = feature.properties.meterRate?.trimmedNonEmpty
        let paidHoursText = feature.properties.paidHours?.trimmedNonEmpty

        return CurbSegment(
            name: name,
            coordinates: coordinates,
            status: status,
            explanation: explanation,
            isMeteredLikely: status == .caution || rateText != nil || paidHoursText != nil,
            nextChange: feature.properties.nextChange.flatMap(iso8601.date(from:)),
            paidHoursText: paidHoursText,
            rateText: rateText,
            confidence: feature.properties.confidence ?? 0.25,
            ruleSummary: explanation,
            sourceFreshness: feature.properties.sourceUpdatedAt,
            sourceName: feature.properties.sourceVersion
        )
    }

    private func mapStatus(_ raw: String?) -> ParkingStatus {
        switch (raw ?? "").lowercased() {
        case "free":
            return .legalNow
        case "paid":
            return .caution
        case "cannot_park":
            return .illegalNow
        default:
            return .unknown
        }
    }

    private func defaultExplanation(for status: ParkingStatus) -> String {
        switch status {
        case .legalNow:
            return "The complete requested interval is classified as free."
        case .caution:
            return "The complete requested interval is resolved and requires payment."
        case .illegalNow:
            return "A confirmed prohibition overlaps the requested interval."
        case .unknown:
            return "The interval, evidence, or curb geometry is unresolved. Check posted signs."
        }
    }

    private func decimalText(_ value: Double) -> String {
        String(format: "%.6f", value)
    }

    private func shouldRejectLoopbackOnDevice(baseURL: URL) -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        let host = (baseURL.host ?? "").lowercased()
        return host == "127.0.0.1" || host == "localhost"
        #endif
    }

    private func validateRuntimeConfiguration() throws {
        guard hasRuntimeConfiguration else {
            throw BackendParkingError.configurationMissing
        }
    }
}

private struct BackendPlanCoordinate: Encodable {
    let latitude: Double
    let longitude: Double
    let label: String?
}

private struct BackendPlanPreferences: Encodable {
    let allowPaid: Bool
    let includeGarages: Bool
    let maxWalkMinutes: Int
    let transit: Bool
    let accessibleOnly: Bool
    let transitModes: [String]
}

private struct BackendPlanRequest: Encodable {
    let origin: BackendPlanCoordinate?
    let destination: BackendPlanCoordinate
    let arriveBy: String
    let leaveAt: String
    let preferences: BackendPlanPreferences
}

private struct BackendFacilitiesResponse: Decodable {
    let facilities: [BackendFacility]
}

private struct BackendFacility: Decodable {
    let name: String
    let address: String
    let latitude: Double
    let longitude: Double
    let phone: String?
    let licenseNumber: String
    let licenseStatus: String
    let licenseExpiresAt: String?
}

private struct BoundingBox {
    let minLat: Double
    let minLng: Double
    let maxLat: Double
    let maxLng: Double

    init(center: CLLocationCoordinate2D, radiusMeters: Double) {
        let latDelta = radiusMeters / 111_320.0
        let latitudeRadians = center.latitude * .pi / 180
        let lonScale = max(cos(latitudeRadians), 0.2)
        let lonDelta = radiusMeters / (111_320.0 * lonScale)

        minLat = max(-90, center.latitude - latDelta)
        maxLat = min(90, center.latitude + latDelta)
        minLng = max(-180, center.longitude - lonDelta)
        maxLng = min(180, center.longitude + lonDelta)
    }

    init(region: MKCoordinateRegion) {
        let minLatRaw = region.center.latitude - (region.span.latitudeDelta / 2)
        let maxLatRaw = region.center.latitude + (region.span.latitudeDelta / 2)
        let minLngRaw = region.center.longitude - (region.span.longitudeDelta / 2)
        let maxLngRaw = region.center.longitude + (region.span.longitudeDelta / 2)

        let latMin = max(-90, min(minLatRaw, maxLatRaw))
        let latMax = min(90, max(minLatRaw, maxLatRaw))
        let lngMin = max(-180, min(minLngRaw, maxLngRaw))
        let lngMax = min(180, max(minLngRaw, maxLngRaw))

        minLat = max(-90, latMin == latMax ? latMin - 0.0008 : latMin)
        maxLat = min(90, latMin == latMax ? latMax + 0.0008 : latMax)
        minLng = max(-180, lngMin == lngMax ? lngMin - 0.0008 : lngMin)
        maxLng = min(180, lngMin == lngMax ? lngMax + 0.0008 : lngMax)
    }
}

private struct BackendViewportResponse: Decodable {
    let features: [BackendFeature]
}

private struct BackendHydrantResponse: Decodable {
    let features: [BackendHydrantFeature]
}

private struct BackendHydrantFeature: Decodable {
    let geometry: BackendHydrantGeometry
    let properties: BackendHydrantProperties?

    var pointCoordinate: CLLocationCoordinate2D? {
        guard geometry.type == "Point",
              properties?.kind == nil || properties?.kind == "hydrant",
              geometry.coordinates.count >= 2 else {
            return nil
        }
        let coordinate = CLLocationCoordinate2D(
            latitude: geometry.coordinates[1],
            longitude: geometry.coordinates[0]
        )
        return CLLocationCoordinate2DIsValid(coordinate) ? coordinate : nil
    }
}

private struct BackendHydrantGeometry: Decodable {
    let type: String
    let coordinates: [Double]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        coordinates = (try? container.decode([Double].self, forKey: .coordinates)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case coordinates
    }
}

private struct BackendHydrantProperties: Decodable {
    let kind: String?
}

private struct BackendFeature: Decodable {
    let geometry: BackendGeometry
    let properties: BackendProperties
}

private struct BackendGeometry: Decodable {
    let type: String
    let coordinates: [CLLocationCoordinate2D]

    enum CodingKeys: String, CodingKey {
        case type
        case coordinates
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)

        switch type {
        case "LineString":
            let pairs = try container.decode([[Double]].self, forKey: .coordinates)
            coordinates = pairs.compactMap(Self.coordinate(from:))
        case "MultiLineString":
            let lines = try container.decode([[[Double]]].self, forKey: .coordinates)
            let longest = lines.max(by: { $0.count < $1.count }) ?? []
            coordinates = longest.compactMap(Self.coordinate(from:))
        default:
            coordinates = []
        }
    }

    nonisolated private static func coordinate(from pair: [Double]) -> CLLocationCoordinate2D? {
        guard pair.count >= 2 else { return nil }
        let longitude = pair[0]
        let latitude = pair[1]
        guard CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) else {
            return nil
        }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

private struct BackendProperties: Decodable {
    let blockfaceKey: String?
    let status: String?
    let confidence: Double?
    let coverage: String?
    let geometryValidated: Bool?
    let ruleSummary: String?
    let nextChange: String?
    let sourceVersion: String?
    let sourceUpdatedAt: String?
    let interpretationVersion: String?
    let onStreet: String?
    let fromStreet: String?
    let toStreet: String?
    let sideOfStreet: String?
    let paidHours: String?
    let meterRate: String?
}

private extension String {
    var trimmedNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
