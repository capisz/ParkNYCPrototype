import Foundation
import CoreLocation
import MapKit

enum BackendParkingError: LocalizedError {
    case invalidURL
    case badStatusCode(Int)
    case deviceLoopbackHost(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Backend URL is invalid."
        case .badStatusCode(let statusCode):
            return "Backend returned HTTP \(statusCode)."
        case .deviceLoopbackHost(let hostURL):
            return "Backend URL \(hostURL) is loopback. On a physical iPhone, use your Mac LAN IP."
        }
    }
}

final class BackendParkingService {
    private let session: URLSession
    private let baseURL: URL
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
        let fallback = "http://127.0.0.1:8080"
        let selected = (configured?.isEmpty == false ? configured : nil) ?? fallback
        self.baseURL = URL(string: selected) ?? URL(string: fallback)!
    }

    func fetchSegments(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int = 900,
        asOf: Date = Date()
    ) async throws -> [CurbSegment] {
        let bbox = BoundingBox(center: coordinate, radiusMeters: Double(radiusMeters))
        let fetched = try await fetchSegments(in: bbox, sortedNear: coordinate, asOf: asOf)
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        return fetched.filter { segment in
            let segmentMidpoint = midpoint(of: segment.coordinates)
            let segmentLocation = CLLocation(latitude: segmentMidpoint.latitude, longitude: segmentMidpoint.longitude)
            return center.distance(from: segmentLocation) <= Double(radiusMeters)
        }
    }

    func fetchSegments(
        in region: MKCoordinateRegion,
        asOf: Date = Date()
    ) async throws -> [CurbSegment] {
        let bbox = BoundingBox(region: region)
        return try await fetchSegments(in: bbox, sortedNear: region.center, asOf: asOf)
    }

    private func fetchSegments(
        in bbox: BoundingBox,
        sortedNear coordinate: CLLocationCoordinate2D,
        asOf: Date
    ) async throws -> [CurbSegment] {
        if shouldRejectLoopbackOnDevice(baseURL: baseURL) {
            throw BackendParkingError.deviceLoopbackHost(baseURL.absoluteString)
        }

        guard var components = URLComponents(url: viewportURL, resolvingAgainstBaseURL: false) else {
            throw BackendParkingError.invalidURL
        }

        components.queryItems = [
            URLQueryItem(name: "minLat", value: decimalText(bbox.minLat)),
            URLQueryItem(name: "minLng", value: decimalText(bbox.minLng)),
            URLQueryItem(name: "maxLat", value: decimalText(bbox.maxLat)),
            URLQueryItem(name: "maxLng", value: decimalText(bbox.maxLng)),
            URLQueryItem(name: "asOf", value: iso8601.string(from: asOf))
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
        if baseURL.path.lowercased().hasSuffix("/api/parking/viewport") {
            return baseURL
        }
        return baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("parking")
            .appendingPathComponent("viewport")
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

        let explanation = feature.properties.ruleSummary?.trimmedNonEmpty ?? feature.properties.reason?.trimmedNonEmpty ?? defaultExplanation(for: status)
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
            sourceFreshness: feature.properties.sourceFreshness
        )
    }

    private func mapStatus(_ raw: String?) -> ParkingStatus {
        switch (raw ?? "").lowercased() {
        case "free":
            return .legalNow
        case "paid":
            return .caution
        case "no_parking":
            return .illegalNow
        default:
            return .unknown
        }
    }

    private func defaultExplanation(for status: ParkingStatus) -> String {
        switch status {
        case .legalNow:
            return "Free parking appears allowed right now."
        case .caution:
            return "Parking appears allowed right now with payment required."
        case .illegalNow:
            return "Parking appears restricted right now."
        case .unknown:
            return "Parking rules are unclear here. Confirm posted signs."
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

    private static func coordinate(from pair: [Double]) -> CLLocationCoordinate2D? {
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
    let reason: String?
    let confidence: Double?
    let ruleSummary: String?
    let nextChange: String?
    let sourceFreshness: String?
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
