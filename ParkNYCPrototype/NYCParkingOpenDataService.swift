import Foundation
import CoreLocation

final class NYCParkingOpenDataService {
    private let meterEndpoint = URL(string: "https://data.cityofnewyork.us/resource/e7yp-wx55.json")!
    private let signEndpoint = URL(string: "https://data.cityofnewyork.us/resource/nfid-uabd.json")!
    private let session: URLSession
    private let appToken: String?

    init(session: URLSession = .shared, appToken: String? = Bundle.main.object(forInfoDictionaryKey: "NYCOpenDataAppToken") as? String) {
        self.session = session
        self.appToken = appToken?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    func fetchSegments(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int = 900,
        limit: Int = 60
    ) async throws -> [CurbSegment] {
        let meterRows = try await fetchMeterRows(near: coordinate, radiusMeters: radiusMeters, limit: limit)
        if meterRows.isEmpty {
            return []
        }

        let keys = Array(Set(meterRows.map(SegmentKey.init(row:))))
        let signMap: [SegmentKey: [String]]
        do {
            signMap = try await fetchSigns(for: keys)
        } catch {
            // Keep meter-driven guidance if sign lookup fails.
            signMap = [:]
            print("Sign lookup failed: \(error.localizedDescription)")
        }

        let now = Date()
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        return meterRows.compactMap { row in
            guard let coordinates = row.coordinates, coordinates.count >= 2 else { return nil }
            let key = SegmentKey(row: row)
            let signs = (signMap[key] ?? []) + (signMap[key.reversedCrossStreet] ?? [])
            let guidance = ParkingGuidanceClassifier.classify(meter: row, signDescriptions: signs, now: now)

            let onStreet = row.onStreet?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "NYC Curb"
            let fromStreet = row.fromStreet?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Unknown"
            let toStreet = row.toStreet?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Unknown"
            let side = row.sideOfStreet?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "?"

            let name = "\(onStreet) (\(side)) • \(fromStreet) to \(toStreet)"

            return CurbSegment(
                name: name,
                coordinates: coordinates,
                status: guidance.status,
                explanation: guidance.explanation,
                isMeteredLikely: guidance.isMeteredLikely,
                nextChange: guidance.nextChange,
                paidHoursText: guidance.paidHoursText,
                rateText: guidance.rateText
            )
        }
        .sorted { lhs, rhs in
            let leftMid = midpoint(of: lhs.coordinates)
            let rightMid = midpoint(of: rhs.coordinates)
            let leftDistance = center.distance(from: CLLocation(latitude: leftMid.latitude, longitude: leftMid.longitude))
            let rightDistance = center.distance(from: CLLocation(latitude: rightMid.latitude, longitude: rightMid.longitude))
            return leftDistance < rightDistance
        }
    }

    private func fetchMeterRows(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int,
        limit: Int
    ) async throws -> [MeterRow] {
        let whereClause = "within_circle(the_geom,\(coordinate.latitude),\(coordinate.longitude),\(radiusMeters))"
        let selectClause = [
            "the_geom",
            "pay_by_cel",
            "vehicle_ty",
            "all_vehicl",
            "all_vehi_1",
            "all_vehi_2",
            "all_vehi_3",
            "on_street",
            "side_of_st",
            "from_stree",
            "to_street",
            "borough",
            "meter_rate"
        ].joined(separator: ",")

        var components = URLComponents(url: meterEndpoint, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "$select", value: selectClause),
            URLQueryItem(name: "$where", value: whereClause),
            URLQueryItem(name: "$limit", value: String(limit))
        ]

        guard let url = components?.url else {
            throw ParkingDataError.invalidRequest
        }

        var request = URLRequest(url: url)
        if let token = appToken {
            request.setValue(token, forHTTPHeaderField: "X-App-Token")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw ParkingDataError.badResponse
        }

        return try JSONDecoder().decode([MeterRow].self, from: data)
    }

    private func fetchSigns(for keys: [SegmentKey]) async throws -> [SegmentKey: [String]] {
        if keys.isEmpty {
            return [:]
        }

        var result: [SegmentKey: [String]] = [:]
        let chunkSize = 20

        for chunkStart in stride(from: 0, to: keys.count, by: chunkSize) {
            let chunk = Array(keys[chunkStart..<min(chunkStart + chunkSize, keys.count)])
            let rows = try await fetchSignChunk(for: chunk)

            for row in rows {
                let key = SegmentKey(
                    borough: row.borough,
                    onStreet: row.onStreet,
                    fromStreet: row.fromStreet,
                    toStreet: row.toStreet,
                    sideOfStreet: row.sideOfStreet
                )
                let description = row.signDescription?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                guard let description else { continue }
                result[key, default: []].append(description)
            }
        }

        return result
    }

    private func fetchSignChunk(for keys: [SegmentKey]) async throws -> [SignRow] {
        let whereClause = SignQueryBuilder.whereClause(for: keys)
        let selectClause = [
            "borough",
            "on_street",
            "from_street",
            "to_street",
            "side_of_street",
            "sign_description"
        ].joined(separator: ",")

        var components = URLComponents(url: signEndpoint, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "$select", value: selectClause),
            URLQueryItem(name: "$where", value: whereClause),
            URLQueryItem(name: "$limit", value: "2000")
        ]

        guard let url = components?.url else {
            throw ParkingDataError.invalidRequest
        }

        var request = URLRequest(url: url)
        if let token = appToken {
            request.setValue(token, forHTTPHeaderField: "X-App-Token")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw ParkingDataError.badResponse
        }

        return try JSONDecoder().decode([SignRow].self, from: data)
    }
}

private enum ParkingDataError: Error {
    case invalidRequest
    case badResponse
}

private struct MeterRow: Decodable {
    let theGeom: GeoMultiLine?
    let payByCell: String?
    let vehicleType: String?
    let allVehicleLimit: String?
    let allVehiclePaidHours: String?
    let allVehicleRate: String?
    let allVehicleMaxSessionRate: String?
    let onStreet: String?
    let sideOfStreet: String?
    let fromStreet: String?
    let toStreet: String?
    let borough: String?
    let meterRate: String?

    enum CodingKeys: String, CodingKey {
        case theGeom = "the_geom"
        case payByCell = "pay_by_cel"
        case vehicleType = "vehicle_ty"
        case allVehicleLimit = "all_vehicl"
        case allVehiclePaidHours = "all_vehi_1"
        case allVehicleRate = "all_vehi_2"
        case allVehicleMaxSessionRate = "all_vehi_3"
        case onStreet = "on_street"
        case sideOfStreet = "side_of_st"
        case fromStreet = "from_stree"
        case toStreet = "to_street"
        case borough
        case meterRate = "meter_rate"
    }

    var coordinates: [CLLocationCoordinate2D]? {
        guard let line = theGeom?.coordinates.max(by: { $0.count < $1.count }) else {
            return nil
        }

        let points = line.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }

        return points.count >= 2 ? points : nil
    }
}

private struct GeoMultiLine: Decodable {
    let coordinates: [[[Double]]]
}

private struct SignRow: Decodable {
    let borough: String?
    let onStreet: String?
    let fromStreet: String?
    let toStreet: String?
    let sideOfStreet: String?
    let signDescription: String?

    enum CodingKeys: String, CodingKey {
        case borough
        case onStreet = "on_street"
        case fromStreet = "from_street"
        case toStreet = "to_street"
        case sideOfStreet = "side_of_street"
        case signDescription = "sign_description"
    }
}

private struct SegmentKey: Hashable {
    let borough: String
    let onStreet: String
    let fromStreet: String
    let toStreet: String
    let sideOfStreet: String

    init(
        borough: String?,
        onStreet: String?,
        fromStreet: String?,
        toStreet: String?,
        sideOfStreet: String?
    ) {
        self.borough = SegmentKey.normalize(borough)
        self.onStreet = SegmentKey.normalize(onStreet)
        self.fromStreet = SegmentKey.normalize(fromStreet)
        self.toStreet = SegmentKey.normalize(toStreet)
        self.sideOfStreet = SegmentKey.normalize(sideOfStreet)
    }

    init(row: MeterRow) {
        self.init(
            borough: row.borough,
            onStreet: row.onStreet,
            fromStreet: row.fromStreet,
            toStreet: row.toStreet,
            sideOfStreet: row.sideOfStreet
        )
    }

    var reversedCrossStreet: SegmentKey {
        SegmentKey(
            borough: borough,
            onStreet: onStreet,
            fromStreet: toStreet,
            toStreet: fromStreet,
            sideOfStreet: sideOfStreet
        )
    }

    private static func normalize(_ value: String?) -> String {
        guard let value else { return "" }
        return value
            .uppercased()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private enum SignQueryBuilder {
    static func whereClause(for keys: [SegmentKey]) -> String {
        let rowClauses = keys.map { key in
            let borough = escaped(key.borough)
            let onStreet = likePattern(for: key.onStreet)
            let fromStreet = likePattern(for: key.fromStreet)
            let toStreet = likePattern(for: key.toStreet)
            let side = escaped(key.sideOfStreet)

            return "(upper(borough)='\(borough)' AND upper(side_of_street)='\(side)' AND upper(on_street) LIKE '\(onStreet)' AND ((upper(from_street) LIKE '\(fromStreet)' AND upper(to_street) LIKE '\(toStreet)') OR (upper(from_street) LIKE '\(toStreet)' AND upper(to_street) LIKE '\(fromStreet)')))"
        }

        let joined = rowClauses.joined(separator: " OR ")
        return "(upper(record_type) = 'CURRENT') AND (\(joined))"
    }

    private static func escaped(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "''")
    }

    private static func likePattern(for value: String) -> String {
        let escapedValue = escaped(value)
        let wildcarded = escapedValue.replacingOccurrences(of: "\\s+", with: "%", options: .regularExpression)
        return "%\(wildcarded)%"
    }
}

private enum ParkingGuidanceClassifier {
    struct Guidance {
        let status: ParkingStatus
        let explanation: String
        let isMeteredLikely: Bool
        let nextChange: Date?
        let paidHoursText: String?
        let rateText: String?
    }

    private enum RestrictionActivity {
        case active(String)
        case inactive
        case unknown(String)
    }

    private static let hardRestrictionKeywords = [
        "NO PARKING",
        "NO STANDING",
        "NO STOPPING",
        "BUS STOP"
    ]

    static func classify(meter: MeterRow, signDescriptions: [String], now: Date) -> Guidance {
        let paidHoursText = meter.allVehiclePaidHours?.cleanedDataField
        let rateText = buildRateText(from: meter)
        let isMeteredLikely = meter.payByCell?.cleanedDataField != nil || rateText != nil

        let restriction = activeRestriction(from: signDescriptions, now: now)
        let paidActive = ScheduleInterpreter.isActiveNow(paidHoursText, at: now) ?? false

        switch restriction {
        case .active(let text):
            return Guidance(
                status: .illegalNow,
                explanation: "Active curb restriction now: \(text)",
                isMeteredLikely: isMeteredLikely,
                nextChange: nil,
                paidHoursText: paidHoursText,
                rateText: rateText
            )
        case .unknown(let text):
            return Guidance(
                status: .illegalNow,
                explanation: "Restriction timing is unclear (\(text)); treated as no parking right now.",
                isMeteredLikely: isMeteredLikely,
                nextChange: nil,
                paidHoursText: paidHoursText,
                rateText: rateText
            )
        case .inactive:
            if paidActive {
                let hours = paidHoursText ?? "meter schedule"
                return Guidance(
                    status: .caution,
                    explanation: "Paid parking is in effect now (\(hours)).",
                    isMeteredLikely: isMeteredLikely,
                    nextChange: nil,
                    paidHoursText: paidHoursText,
                    rateText: rateText
                )
            }

            return Guidance(
                status: .legalNow,
                explanation: "No active hard restriction found, and meter is outside paid hours right now.",
                isMeteredLikely: isMeteredLikely,
                nextChange: nil,
                paidHoursText: paidHoursText,
                rateText: rateText
            )
        }
    }

    private static func activeRestriction(from signs: [String], now: Date) -> RestrictionActivity {
        let candidates = signs
            .map { $0.uppercased() }
            .filter { text in hardRestrictionKeywords.contains(where: text.contains) }

        var firstUnknown: String?

        for text in candidates {
            if isAlwaysActive(text) {
                return .active(text)
            }

            if let isActive = ScheduleInterpreter.isActiveNow(text, at: now) {
                if isActive {
                    return .active(text)
                }
            } else if firstUnknown == nil {
                firstUnknown = text
            }
        }

        if let firstUnknown {
            return .unknown(firstUnknown)
        }

        return .inactive
    }

    private static func isAlwaysActive(_ text: String) -> Bool {
        if text.contains("BUS STOP") {
            return true
        }
        return text.contains("ANYTIME") && !text.contains("EXCEPT")
    }

    private static func buildRateText(from meter: MeterRow) -> String? {
        let primary = meter.allVehicleRate?.cleanedDataField
        let cap = meter.allVehicleMaxSessionRate?.cleanedDataField

        switch (primary, cap) {
        case let (p?, c?) where p != c:
            return "\(p) • Max session \(c)"
        case let (p?, _):
            return p
        case let (_, c?):
            return c
        default:
            return nil
        }
    }
}

private enum ScheduleInterpreter {
    private static let nyTimeZone = TimeZone(identifier: "America/New_York") ?? .current
    private static let calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = nyTimeZone
        return c
    }()

    private static let dayRegex = try! NSRegularExpression(
        pattern: #"MON(?:DAY)?|TUE(?:SDAY)?|WED(?:NESDAY)?|THU(?:RSDAY)?|FRI(?:DAY)?|SAT(?:URDAY)?|SUN(?:DAY)?"#,
        options: []
    )

    private static let dayRangeRegex = try! NSRegularExpression(
        pattern: #"(MON(?:DAY)?|TUE(?:SDAY)?|WED(?:NESDAY)?|THU(?:RSDAY)?|FRI(?:DAY)?|SAT(?:URDAY)?|SUN(?:DAY)?)\s*-\s*(MON(?:DAY)?|TUE(?:SDAY)?|WED(?:NESDAY)?|THU(?:RSDAY)?|FRI(?:DAY)?|SAT(?:URDAY)?|SUN(?:DAY)?)"#,
        options: []
    )

    private static let timeRangeRegex = try! NSRegularExpression(
        pattern: #"(\d{1,2}(?::\d{2})?\s*[AP]M)\s*-\s*(\d{1,2}(?::\d{2})?\s*[AP]M)"#,
        options: []
    )

    static func isActiveNow(_ rawText: String?, at now: Date) -> Bool? {
        guard let rawText else { return nil }
        let text = normalize(rawText)
        if text.isEmpty || text == "N/A" {
            return false
        }

        if text.contains("ANYTIME") && !text.contains("EXCEPT") {
            return true
        }

        let weekday = calendar.component(.weekday, from: now)
        let minuteOfDay = calendar.component(.hour, from: now) * 60 + calendar.component(.minute, from: now)

        let exceptionDays = parseExceptionDays(from: text)
        if exceptionDays.contains(weekday) {
            return false
        }

        let fallbackDays = parseDays(from: text)
        let clauses = text.split(whereSeparator: { $0 == "," || $0 == ";" }).map(String.init)

        var parsedAtLeastOneWindow = false
        for clause in clauses {
            let ranges = parseTimeRanges(from: clause)
            guard !ranges.isEmpty else { continue }
            parsedAtLeastOneWindow = true

            let clauseDays = parseDays(from: clause)
            let activeDays = clauseDays.isEmpty ? fallbackDays : clauseDays
            let daySet = activeDays.isEmpty ? Set(1...7) : activeDays

            guard daySet.contains(weekday) else { continue }
            if ranges.contains(where: { $0.contains(minuteOfDay) }) {
                return true
            }
        }

        if parsedAtLeastOneWindow {
            return false
        }

        return nil
    }

    private static func parseExceptionDays(from text: String) -> Set<Int> {
        guard let range = text.range(of: "EXCEPT ") else {
            return []
        }
        let tail = String(text[range.upperBound...])
        return parseDays(from: tail)
    }

    private static func parseDays(from text: String) -> Set<Int> {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)

        var days = Set<Int>()

        for match in dayRangeRegex.matches(in: text, options: [], range: fullRange) {
            guard match.numberOfRanges == 3,
                  let lhs = dayIndex(nsText.substring(with: match.range(at: 1))),
                  let rhs = dayIndex(nsText.substring(with: match.range(at: 2))) else {
                continue
            }
            days.formUnion(expandDayRange(from: lhs, to: rhs))
        }

        for match in dayRegex.matches(in: text, options: [], range: fullRange) {
            let token = nsText.substring(with: match.range)
            guard let day = dayIndex(token) else { continue }
            days.insert(day)
        }

        return days
    }

    private static func parseTimeRanges(from text: String) -> [MinuteRange] {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)

        return timeRangeRegex.matches(in: text, options: [], range: fullRange).compactMap { match in
            guard match.numberOfRanges == 3 else { return nil }
            let startToken = nsText.substring(with: match.range(at: 1))
            let endToken = nsText.substring(with: match.range(at: 2))
            guard let start = parseMinutes(startToken), let end = parseMinutes(endToken) else {
                return nil
            }
            return MinuteRange(start: start, end: end)
        }
    }

    private static func parseMinutes(_ token: String) -> Int? {
        let compact = token
            .uppercased()
            .replacingOccurrences(of: " ", with: "")

        let regex = try! NSRegularExpression(pattern: #"^(\d{1,2})(?::(\d{2}))?(AM|PM)$"#)
        let ns = compact as NSString
        let range = NSRange(location: 0, length: ns.length)
        guard let match = regex.firstMatch(in: compact, options: [], range: range) else {
            return nil
        }

        guard let hour = Int(ns.substring(with: match.range(at: 1))) else {
            return nil
        }

        let minute: Int
        if match.range(at: 2).location != NSNotFound {
            minute = Int(ns.substring(with: match.range(at: 2))) ?? 0
        } else {
            minute = 0
        }

        let ampm = ns.substring(with: match.range(at: 3))
        var hour24 = hour % 12
        if ampm == "PM" {
            hour24 += 12
        }
        return hour24 * 60 + minute
    }

    private static func dayIndex(_ token: String) -> Int? {
        switch token.prefix(3) {
        case "SUN": return 1
        case "MON": return 2
        case "TUE": return 3
        case "WED": return 4
        case "THU": return 5
        case "FRI": return 6
        case "SAT": return 7
        default: return nil
        }
    }

    private static func expandDayRange(from start: Int, to end: Int) -> Set<Int> {
        if start <= end {
            return Set(start...end)
        }
        return Set(Array(start...7) + Array(1...end))
    }

    private static func normalize(_ text: String) -> String {
        text
            .uppercased()
            .replacingOccurrences(of: "THRU", with: "-")
            .replacingOccurrences(of: "THROUGH", with: "-")
            .replacingOccurrences(of: " TO ", with: "-")
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private struct MinuteRange {
        let start: Int
        let end: Int

        func contains(_ minute: Int) -> Bool {
            if start == end {
                return true
            }
            if end > start {
                return minute >= start && minute < end
            }
            return minute >= start || minute < end
        }
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }

    var cleanedDataField: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.uppercased() == "N/A" {
            return nil
        }
        return trimmed
    }
}
