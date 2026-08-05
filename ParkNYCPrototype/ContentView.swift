import SwiftUI
import MapKit
import Combine
import CoreLocation

private enum AppStage {
    case landing
    case results
}

private enum MapOverlayState {
    case collapsed
    case browsing
    case selected
}

private enum MapSheetPosition: Int, CaseIterable {
    case minimized
    case half
    case expanded
}

private enum ParkingMode: String, CaseIterable, Identifiable {
    case best = "Best"
    case street = "Street"
    case garages = "Garages"

    var id: String { rawValue }
}

private enum DestinationLookupError: Error {
    case noResults
}

private enum AppTheme {
    static let cloud = Color(hex: "#BDC2DB")
    static let haze = Color(hex: "#ADA9B7")
    static let breeze = Color(hex: "#B6D8F6")
    static let ink = Color(hex: "#2C3240")
    static let action = Color(hex: "#4E6CA8")
    static let softSurface = Color.white.opacity(0.72)
}

private struct BestRecommendationMarker: View {
    let color: Color
    let isBest: Bool
    let isSelected: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        ZStack {
            if isBest {
                Circle()
                    .stroke(color.opacity(0.9), lineWidth: 4)
                    .frame(width: 38, height: 38)
                    .scaleEffect(pulse ? 1.55 : 0.72)
                    .opacity(pulse ? 0.05 : 0.75)
            }

            Circle()
                .fill(Color.white)
                .frame(width: isSelected ? 34 : 30, height: isSelected ? 34 : 30)
            Circle()
                .fill(color)
                .frame(width: isSelected ? 24 : 20, height: isSelected ? 24 : 20)

            if isBest {
                Text("BEST")
                    .font(.system(size: 8, weight: .black))
                    .tracking(0.7)
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(AppTheme.ink, in: Capsule())
                    .offset(y: -29)
            }
        }
        .frame(width: 58, height: 58)
        .shadow(color: AppTheme.ink.opacity(0.22), radius: 4, y: 2)
        .onAppear {
            guard isBest, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.5).repeatForever(autoreverses: false)) {
                pulse = true
            }
        }
    }
}

struct ContentView: View {
    @StateObject private var locationManager = LocationManager()
    @StateObject private var curbVM = CurbViewModel()
    @StateObject private var locationSuggestions = LocationSuggestionsStore()

    private let facilityService = BackendParkingService()
    private let recommendationService = BackendParkingService()
    private let hydrantService = BackendParkingService()
    private let liveRefreshTimer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    private let countdownTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    @State private var appStage: AppStage = .landing
    @State private var mode: ParkingMode = .best
    @State private var mapOverlayState: MapOverlayState = .collapsed
    @State private var mapSheetPosition: MapSheetPosition = .half
    @State private var mapSheetDragOffset: CGFloat = 0

    @State private var searchText: String = ""
    @State private var searchStatus: String? = nil
    @State private var isSearchingDestination = false
    @State private var isWaitingForCurrentLocation = false
    @State private var pendingSuggestion: MKLocalSearchCompletion?

    @State private var destinationName: String = ""
    @State private var destinationCoordinate: CLLocationCoordinate2D?
    @State private var mapCenterCoordinate: CLLocationCoordinate2D?
    @State private var mapVisibleRegion: MKCoordinateRegion?
    @State private var countdownNow: Date = Date()
    @State private var arrivalDate: Date = Date().addingTimeInterval(15 * 60)
    @State private var departureDate: Date = Date().addingTimeInterval(2 * 60 * 60)
    @State private var maxWalkMinutes = 10
    @State private var allowPaidParking = true
    @State private var allowGarages = true

    @State private var position: MapCameraPosition = .automatic

    @State private var selectedStreet: CurbSegment?
    @State private var recommendations: [ParkingRecommendation] = []
    @State private var selectedRecommendation: ParkingRecommendation?
    @State private var recommendationAvailability: ParkingAvailability?
    @State private var recommendationStatus: String?
    @State private var isLoadingRecommendations = false
    @State private var recommendationTask: Task<Void, Never>?

    @State private var garages: [GarageOption] = []
    @State private var selectedGarage: GarageOption?
    @State private var garageStatus: String? = nil
    @State private var isLoadingGarages = false
    @State private var hydrants: [HydrantPoint] = []
    @State private var hydrantNoParkingSegments: [HydrantNoParkingSegment] = []
    @State private var hydrantFetchTask: Task<Void, Never>?
    @State private var lastHydrantFetchCenter: CLLocationCoordinate2D?
    @State private var lastHydrantFetchDate: Date?
    @State private var lastHydrantFetchRadiusMeters: Int?
    @State private var hydrantVisibilityShortEdgeThresholdMeters: Double?

    @State private var landingCardVisible = false

    private let hydrantZoomInStepFactor = 0.72
    private let hydrantZoomInStepsRequired = 4
    private let hydrantNoParkingEachSideMeters: Double = 4.57
    private let hydrantSegmentSnapMaxDistanceMeters: Double = 22

    private var shouldShowSuggestions: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !isSearchingDestination &&
        !locationSuggestions.suggestions.isEmpty
    }

    private var navTitle: String { "NYC Parking Planner" }

    var body: some View {
        NavigationStack {
            ZStack {
                if appStage == .landing {
                    landingView
                        .transition(.opacity)
                } else {
                    resultsView
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.28), value: appStage)
            .tint(AppTheme.action)
            .navigationTitle(navTitle)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .onReceive(liveRefreshTimer) { _ in
                guard appStage == .results,
                      mode != .garages else { return }
                if let mapVisibleRegion {
                    curbVM.refresh(in: mapVisibleRegion, force: true)
                } else if let refreshCoordinate = mapCenterCoordinate ?? destinationCoordinate {
                    curbVM.refresh(near: refreshCoordinate, force: true)
                }
            }
            .onReceive(countdownTimer) { _ in
                guard appStage == .results,
                      mode != .garages else { return }
                countdownNow = Date()
            }
            .onReceive(curbVM.$segments) { segments in
                recalculateHydrantNoParkingSegments(segments: segments)
            }
            .onReceive(locationManager.$location.compactMap { $0 }) { location in
                guard isWaitingForCurrentLocation else { return }
                isWaitingForCurrentLocation = false
                let item = MKMapItem(placemark: MKPlacemark(coordinate: location.coordinate))
                applyDestination(item: item, fallbackName: "Current location")
            }
            .onReceive(locationManager.$authorizationStatus) { status in
                guard isWaitingForCurrentLocation,
                      status == .denied || status == .restricted else { return }
                isWaitingForCurrentLocation = false
                searchStatus = "Location access is unavailable. Enter a destination instead."
            }
        }
    }

    private var landingView: some View {
        ZStack {
            AnimatedLandingBackground()

            GeometryReader { proxy in
                let panelWidth = max(CGFloat(232), min(CGFloat(360), proxy.size.width - 104))

                VStack(spacing: 0) {
                    Spacer(minLength: 0)

                    VStack(spacing: 14) {
                        PidgeBrandMark()
                            .padding(.bottom, 18)

                        HStack(spacing: 10) {
                            TextField("e.g., 350 5th Ave, New York", text: $searchText)
                                .foregroundStyle(AppTheme.ink)
                                .onChange(of: searchText) { _, newValue in
                                    searchStatus = nil
                                    if let pendingSuggestion {
                                        let pendingText = locationSuggestions.formattedText(for: pendingSuggestion)
                                        if pendingText == newValue {
                                            locationSuggestions.clear()
                                            return
                                        }
                                    }
                                    pendingSuggestion = nil
                                    locationSuggestions.update(query: newValue)
                                }
                                .submitLabel(.search)
                                .onSubmit {
                                    goToSelectedDestinationFromLanding()
                                }

                            Button {
                                goToSelectedDestinationFromLanding()
                            } label: {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .fill(AppTheme.action.opacity(0.9))
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(AppTheme.ink.opacity(0.18), lineWidth: 1)
                                    Image(systemName: "arrow.right")
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                                .frame(width: 36, height: 36)
                            }
                            .buttonStyle(.plain)
                            .disabled(
                                isSearchingDestination ||
                                (pendingSuggestion == nil && searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            )
                            .opacity(
                                isSearchingDestination ||
                                (pendingSuggestion == nil && searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                ? 0.45
                                : 1
                            )
                            .accessibilityLabel("Go to selected destination")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 15, style: .continuous)
                                .fill(Color.white.opacity(0.9))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                                        .fill(AppTheme.breeze.opacity(0.08))
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                                        .stroke(AppTheme.cloud.opacity(0.45), lineWidth: 1)
                                )
                        )
                        .shadow(color: AppTheme.haze.opacity(0.18), radius: 7, x: 0, y: 4)
                        .frame(maxWidth: .infinity)

                        Button {
                            isWaitingForCurrentLocation = true
                            searchStatus = "Waiting for your location…"
                            locationManager.start()
                        } label: {
                            Label(
                                isWaitingForCurrentLocation ? "Locating…" : "Use my location",
                                systemImage: "location.fill"
                            )
                            .font(.caption.weight(.bold))
                            .frame(maxWidth: .infinity, minHeight: 36)
                        }
                        .buttonStyle(.bordered)
                        .disabled(isWaitingForCurrentLocation)

                        if shouldShowSuggestions {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 0) {
                                    ForEach(Array(locationSuggestions.suggestions.prefix(6).indices), id: \.self) { index in
                                        let suggestion = locationSuggestions.suggestions[index]
                                        Button {
                                            applySuggestion(suggestion)
                                        } label: {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(suggestion.title)
                                                    .font(.subheadline)
                                                    .foregroundStyle(AppTheme.ink)
                                                    .lineLimit(1)

                                                if !suggestion.subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                                    Text(suggestion.subtitle)
                                                        .font(.caption)
                                                        .foregroundStyle(AppTheme.ink.opacity(0.7))
                                                        .lineLimit(1)
                                                }
                                            }
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.vertical, 8)
                                            .padding(.horizontal, 10)
                                            .background(
                                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                                    .fill(
                                                        index.isMultiple(of: 2)
                                                        ? Color.white.opacity(0.52)
                                                        : AppTheme.breeze.opacity(0.24)
                                                    )
                                            )
                                        }
                                        .buttonStyle(.plain)
                                        .padding(.horizontal, 4)
                                        .padding(.vertical, 2)

                                        if index < min(locationSuggestions.suggestions.count, 6) - 1 {
                                            Divider()
                                                .overlay(AppTheme.action.opacity(0.08))
                                        }
                                    }
                                }
                            }
                            .frame(maxHeight: 190)
                            .background(
                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                    .fill(AppTheme.cloud.opacity(0.56))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                                            .stroke(AppTheme.action.opacity(0.18), lineWidth: 1)
                                    )
                            )
                            .frame(maxWidth: .infinity)
                            .transition(.opacity)
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label("Arrival", systemImage: "clock")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(AppTheme.ink.opacity(0.78))
                                Spacer()
                                DatePicker(
                                    "Arrival",
                                    selection: $arrivalDate,
                                    in: Date().addingTimeInterval(-3600)...Date().addingTimeInterval(30 * 24 * 3600),
                                    displayedComponents: [.date, .hourAndMinute]
                                )
                                .labelsHidden()
                                .datePickerStyle(.compact)
                                .onChange(of: arrivalDate) { _, newArrival in
                                    if departureDate <= newArrival {
                                        departureDate = newArrival.addingTimeInterval(60 * 60)
                                    }
                                }
                            }

                            HStack {
                                Label("Leave", systemImage: "clock.arrow.circlepath")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(AppTheme.ink.opacity(0.78))
                                Spacer()
                                DatePicker(
                                    "Leave",
                                    selection: $departureDate,
                                    in: arrivalDate.addingTimeInterval(60)...arrivalDate.addingTimeInterval(7 * 24 * 3600),
                                    displayedComponents: [.date, .hourAndMinute]
                                )
                                .labelsHidden()
                                .datePickerStyle(.compact)
                            }

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Maximum walk")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(AppTheme.ink.opacity(0.7))
                                HStack(spacing: 5) {
                                    ForEach([5, 10, 15, 20], id: \.self) { minutes in
                                        Button("\(minutes) min") {
                                            maxWalkMinutes = minutes
                                        }
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(maxWalkMinutes == minutes ? Color.white : AppTheme.ink)
                                        .frame(maxWidth: .infinity, minHeight: 34)
                                        .background(
                                            maxWalkMinutes == minutes ? AppTheme.ink.opacity(0.9) : Color.white.opacity(0.58),
                                            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                                        )
                                        .buttonStyle(.plain)
                                        .accessibilityAddTraits(maxWalkMinutes == minutes ? .isSelected : [])
                                    }
                                }
                            }

                            HStack(spacing: 6) {
                                landingPreferenceButton(
                                    title: "Paid",
                                    systemImage: "dollarsign.circle.fill",
                                    isOn: $allowPaidParking
                                )
                                landingPreferenceButton(
                                    title: "Garages",
                                    systemImage: "parkingsign.circle.fill",
                                    isOn: $allowGarages
                                )
                                Label("Transit gated", systemImage: "tram.fill")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(AppTheme.ink.opacity(0.62))
                                    .frame(maxWidth: .infinity, minHeight: 34)
                                    .background(Color.white.opacity(0.45), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            }

                            Text("Park-and-ride remains behind the transit validation gate.")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.ink.opacity(0.68))
                        }
                        .padding(11)
                        .background(Color.white.opacity(0.48), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(AppTheme.action.opacity(0.15), lineWidth: 1)
                        )

                        if isSearchingDestination {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Loading parking options…")
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.ink.opacity(0.72))
                            }
                            .frame(maxWidth: .infinity, alignment: .center)
                        }

                        if let searchStatus {
                            Text(searchStatus)
                                .font(.caption)
                                .foregroundStyle(AppTheme.ink.opacity(0.75))
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.horizontal, 8)
                    .frame(width: panelWidth)
                    .opacity(landingCardVisible ? 1 : 0)
                    .offset(y: landingCardVisible ? 4 : 18)

                    Spacer(minLength: 0)

                    Text("Anonymous advisory service • No trip history is stored")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .multilineTextAlignment(.center)
                        .frame(width: panelWidth)
                    .padding(.bottom, max(16, proxy.safeAreaInsets.bottom + 6))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .onAppear {
                landingCardVisible = false
                withAnimation(.easeOut(duration: 0.4)) {
                    landingCardVisible = true
                }
            }
        }
    }

    private func landingPreferenceButton(
        title: String,
        systemImage: String,
        isOn: Binding<Bool>
    ) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.caption)
                Text(title)
                    .font(.caption2.weight(.bold))
                    .lineLimit(1)
            }
            .foregroundStyle(isOn.wrappedValue ? Color.white : AppTheme.ink.opacity(0.76))
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                isOn.wrappedValue ? AppTheme.action.opacity(0.9) : AppTheme.cloud.opacity(0.48),
                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn.wrappedValue ? "On" : "Off")
    }

    private var resultsView: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                resultsMap

                VStack {
                    HStack {
                        Spacer()
                        VStack(spacing: 8) {
                            Button {
                                focusOnBestParking()
                            } label: {
                                Image(systemName: "scope")
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundStyle(AppTheme.ink)
                                    .frame(width: 40, height: 40)
                                    .background(AppTheme.cloud.opacity(0.96), in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(recommendations.isEmpty ? "Center map on destination" : "Center map on best parking lead")

                            zoomControls
                        }
                    }
                    Spacer()
                }
                .padding(.top, 10)
                .padding(.trailing, 12)

                nativeMapSheet(containerHeight: proxy.size.height)
            }
        }
    }

    private var resultsMap: some View {
        MapReader { proxy in
            Map(position: $position) {
                if let destinationCoordinate {
                    Marker("Destination", systemImage: "mappin.and.ellipse", coordinate: destinationCoordinate)
                        .tint(AppTheme.action)
                }

                if mode != .garages {
                    streetMapLayer
                    hydrantMapLayer
                    if mode == .best {
                        recommendationMapLayer
                    }
                } else {
                    garageMapLayer
                }
            }
            .onMapCameraChange(frequency: .onEnd) { context in
                guard appStage == .results else { return }
                let center = context.region.center
                guard CLLocationCoordinate2DIsValid(center) else { return }

                mapCenterCoordinate = center
                mapVisibleRegion = context.region
                if mode != .garages {
                    initializeHydrantVisibilityThresholdIfNeeded(for: context.region)
                    curbVM.refresh(in: context.region)
                    refreshHydrants(for: context.region)
                }
            }
            .simultaneousGesture(
                SpatialTapGesture().onEnded { value in
                    guard let coordinate = proxy.convert(value.location, from: .local) else { return }
                    if mode != .garages {
                        handleStreetTap(at: coordinate)
                    } else {
                        handleGarageTap(at: coordinate)
                    }
                }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 6).onChanged { _ in
                    withAnimation(.easeOut(duration: 0.2)) {
                        mapSheetPosition = .minimized
                    }
                }
            )
            .mapStyle(.standard(elevation: .realistic))
            .mapControls {
                MapCompass()
                MapScaleView()
            }
            .ignoresSafeArea()
        }
    }

    private var mapToolbar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    focusOnBestParking()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "scope")
                            .font(.caption)
                        Text(destinationName.isEmpty ? "Destination" : destinationName)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(AppTheme.ink)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(recommendations.isEmpty ? "Center map on destination" : "Center map on best parking lead")

                Spacer(minLength: 0)

                Button {
                    resetToLanding()
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 32, height: 32)
                        .background(AppTheme.breeze.opacity(0.72), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New Search")
            }

            Picker("Parking Type", selection: $mode) {
                ForEach(ParkingMode.allCases) { currentMode in
                    Text(currentMode.rawValue).tag(currentMode)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: mode) { _, newMode in
                handleModeChange(newMode)
            }
        }
        .padding(10)
        .frame(maxWidth: 290)
        .background(AppTheme.cloud.opacity(0.94), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(AppTheme.action.opacity(0.2), lineWidth: 1)
        )
        .shadow(color: AppTheme.ink.opacity(0.16), radius: 9, y: 4)
    }

    private func nativeMapSheet(containerHeight: CGFloat) -> some View {
        let minimizedHeight: CGFloat = 94
        let halfHeight = max(300, min(containerHeight * 0.52, 470))
        let expandedHeight = max(halfHeight, min(containerHeight * 0.86, 760))
        let height: CGFloat
        switch mapSheetPosition {
        case .minimized:
            height = minimizedHeight
        case .half:
            height = halfHeight
        case .expanded:
            height = expandedHeight
        }

        return VStack(spacing: 0) {
            Capsule()
                .fill(AppTheme.ink.opacity(0.3))
                .frame(width: 38, height: 5)
                .padding(.top, 8)
                .padding(.bottom, 7)
                .accessibilityHidden(true)

            nativeSheetHeader

            if mapSheetPosition != .minimized {
                Divider()
                    .padding(.top, 9)

                Picker("Parking Type", selection: $mode) {
                    ForEach(ParkingMode.allCases) { currentMode in
                        Text(currentMode.rawValue).tag(currentMode)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .onChange(of: mode) { _, newMode in
                    handleModeChange(newMode)
                }

                nativeAvailabilityStrip
                    .padding(.horizontal, 14)
                    .padding(.top, 9)

                nativeLiveStatus
                    .padding(.horizontal, 14)
                    .padding(.top, 7)

                nativeSheetContent
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .padding(.bottom, 10)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height, alignment: .top)
        .background(AppTheme.cloud.opacity(0.98))
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(AppTheme.action.opacity(0.2), lineWidth: 1)
        )
        .shadow(color: AppTheme.ink.opacity(0.22), radius: 16, y: -4)
        .padding(.horizontal, 7)
        .padding(.bottom, 5)
        .offset(y: max(0, mapSheetDragOffset))
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { value in
                    mapSheetDragOffset = value.translation.height
                }
                .onEnded { value in
                    let threshold: CGFloat = 70
                    if value.translation.height > threshold {
                        moveMapSheet(by: -1)
                    } else if value.translation.height < -threshold {
                        moveMapSheet(by: 1)
                    }
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                        mapSheetDragOffset = 0
                    }
                }
        )
        .animation(.spring(response: 0.34, dampingFraction: 0.86), value: mapSheetPosition)
    }

    private var nativeSheetHeader: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(destinationName.isEmpty ? "Destination" : destinationName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(AppTheme.ink)
                    .lineLimit(1)
                Text("\(nativeResultCount) \(nativeResultLabel)")
                    .font(.caption)
                    .foregroundStyle(AppTheme.ink.opacity(0.66))
            }

            Spacer(minLength: 4)

            Button {
                resetToLanding()
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: 44, height: 44)
                    .background(AppTheme.breeze.opacity(0.72), in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New search")

            sheetPositionButtons
        }
        .padding(.horizontal, 14)
    }

    private var sheetPositionButtons: some View {
        HStack(spacing: 4) {
            Button {
                moveMapSheet(by: -1)
            } label: {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .frame(width: 44, height: 44)
                    .background(AppTheme.breeze.opacity(0.62), in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppTheme.ink)
            .disabled(mapSheetPosition == .minimized)
            .opacity(mapSheetPosition == .minimized ? 0.35 : 1)
            .accessibilityLabel("Minimize results")

            Button {
                moveMapSheet(by: 1)
            } label: {
                Image(systemName: "chevron.up")
                    .font(.caption.weight(.bold))
                    .frame(width: 44, height: 44)
                    .background(AppTheme.breeze.opacity(0.62), in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppTheme.ink)
            .disabled(mapSheetPosition == .expanded)
            .opacity(mapSheetPosition == .expanded ? 0.35 : 1)
            .accessibilityLabel("Expand results")
        }
    }

    @ViewBuilder
    private var nativeAvailabilityStrip: some View {
        if mode != .garages {
            let availability = currentAvailability
            HStack(spacing: 7) {
                availabilityPill(label: "Likely free", value: availability.free, color: .green)
                availabilityPill(label: "Paid", value: availability.paid, color: .yellow)
                availabilityPill(label: "Cannot park", value: availability.cannotPark, color: .red)
                availabilityPill(label: "Unknown", value: availability.unknown, color: .gray)
            }
        }
    }

    private func availabilityPill(label: String, value: Int, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text("\(value) \(label)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(AppTheme.ink)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Color.white.opacity(0.52), in: Capsule())
    }

    @ViewBuilder
    private var nativeLiveStatus: some View {
        let status = currentNativeStatus
        if !status.isEmpty || isCurrentModeLoading {
            HStack(spacing: 8) {
                if isCurrentModeLoading {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.ink.opacity(0.72))
                    .lineLimit(2)
                Spacer(minLength: 4)
                if currentModeHasError {
                    Button("Retry") {
                        retryCurrentMode()
                    }
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.ink)
                    .frame(minWidth: 54, minHeight: 34)
                    .background(AppTheme.breeze.opacity(0.75), in: Capsule())
                    .buttonStyle(.plain)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private var nativeSheetContent: some View {
        if let recommendation = selectedRecommendation {
            recommendationDetail(recommendation)
        } else if let segment = selectedStreet {
            ParkingPopup(
                segment: segment,
                nextChange: nextChangeDate(for: segment, reference: countdownNow),
                countdownText: countdownText(for: segment, now: countdownNow),
                onClose: dismissMapOverlay
            )
        } else if let garage = selectedGarage {
            GaragePopup(garage: garage, onClose: dismissMapOverlay)
        } else {
            switch mode {
            case .best:
                recommendationOptionsPanel
            case .street:
                streetOptionsPanel
            case .garages:
                garageOptionsPanel
            }
        }
    }

    private var recommendationOptionsPanel: some View {
        Group {
            if recommendations.isEmpty {
                Text(isLoadingRecommendations ? "Evaluating the complete interval…" : "No eligible advisory recommendations are available for these preferences.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.ink.opacity(0.7))
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView {
                    LazyVStack(spacing: 9) {
                        ForEach(recommendations.prefix(60)) { recommendation in
                            Button {
                                selectRecommendation(recommendation)
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Circle()
                                        .fill(recommendation.statusColor)
                                        .frame(width: 12, height: 12)
                                        .overlay(Circle().stroke(Color.white, lineWidth: 2))
                                        .padding(.top, 5)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(recommendation.title)
                                            .font(.subheadline.weight(.bold))
                                            .foregroundStyle(AppTheme.ink)
                                            .lineLimit(1)
                                        Text(recommendation.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(AppTheme.ink.opacity(0.68))
                                            .lineLimit(2)
                                        Text("\(recommendation.tierLabel) · \(recommendation.walkMinutes) min walk")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(AppTheme.action)
                                    }
                                    Spacer(minLength: 4)
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(AppTheme.ink.opacity(0.45))
                                }
                                .padding(10)
                                .background(Color.white.opacity(0.52), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func recommendationDetail(_ recommendation: ParkingRecommendation) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(recommendation.title)
                            .font(.headline)
                            .foregroundStyle(AppTheme.ink)
                        Text(recommendation.tierLabel)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(recommendation.statusColor)
                    }
                    Spacer()
                    Button(action: dismissMapOverlay) {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(AppTheme.ink)
                            .frame(width: 44, height: 44)
                            .background(AppTheme.breeze.opacity(0.62), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close recommendation details")
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text("PLANNED PARKING WINDOW")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AppTheme.ink.opacity(0.62))
                    Text(plannedParkingWindowText)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppTheme.ink)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(AppTheme.breeze.opacity(0.46), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text(recommendation.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.ink.opacity(0.74))
                Text(recommendation.ruleSummary)
                    .font(.callout)
                    .foregroundStyle(AppTheme.ink)
                Text("Confidence: \(Int(((recommendation.confidence ?? 0) * 100).rounded()))% · \(recommendation.walkMinutes) min walk")
                    .font(.caption)
                    .foregroundStyle(AppTheme.ink.opacity(0.66))

                if let countdown = recommendationCountdown(recommendation) {
                    Text("Rule changes in \(countdown)")
                        .font(.caption.monospacedDigit().weight(.bold))
                        .foregroundStyle(AppTheme.action)
                }

                if let transit = recommendation.transit {
                    Text("Transit timing: \(transit.state == "live" ? "realtime" : "scheduled")")
                        .font(.caption)
                        .foregroundStyle(AppTheme.ink.opacity(0.72))
                }

                if let facility = recommendation.facility,
                   let licenseNumber = facility.licenseNumber {
                    Text("NYC DCWP license \(licenseNumber) · \(facility.licenseStatus ?? "status unavailable")")
                        .font(.caption)
                        .foregroundStyle(AppTheme.ink.opacity(0.72))
                }

                Text("Advisory only. Verify posted signs, meter or ParkNYC instructions, and facility terms. A result does not guarantee an open physical space.")
                    .font(.caption2)
                    .foregroundStyle(AppTheme.ink.opacity(0.58))
            }
            .padding(12)
            .background(Color.white.opacity(0.5), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
    }

    private var nativeResultCount: Int {
        switch mode {
        case .best: return recommendations.count
        case .street: return curbVM.segments.count
        case .garages: return garages.count
        }
    }

    private var nativeResultLabel: String {
        switch mode {
        case .best: return "ranked options"
        case .street: return "visible curbs"
        case .garages: return "active licensed facilities"
        }
    }

    private var currentAvailability: ParkingAvailability {
        if mode == .best, let recommendationAvailability {
            return recommendationAvailability
        }
        return ParkingAvailability(
            cannotPark: curbVM.segments.filter { $0.status == .illegalNow }.count,
            paid: curbVM.segments.filter { $0.status == .caution }.count,
            free: curbVM.segments.filter { $0.status == .legalNow }.count,
            unknown: curbVM.segments.filter { $0.status == .unknown }.count
        )
    }

    private var currentNativeStatus: String {
        switch mode {
        case .best:
            return recommendationStatus ?? (isLoadingRecommendations ? "Checking advisory parking options…" : "Advisory interval-aware options")
        case .street:
            return curbVM.errorMessage ?? curbVM.sourceLabel
        case .garages:
            return garageStatus ?? (garages.isEmpty ? "No licensed facilities loaded" : "Active licensed facilities; capacity and pricing are not provided")
        }
    }

    private var isCurrentModeLoading: Bool {
        switch mode {
        case .best: return isLoadingRecommendations
        case .street: return curbVM.isLoading
        case .garages: return isLoadingGarages
        }
    }

    private var currentModeHasError: Bool {
        switch mode {
        case .best: return recommendationStatus?.contains("failed") == true
        case .street: return curbVM.errorMessage != nil
        case .garages: return garageStatus?.contains("failed") == true
        }
    }

    private func retryCurrentMode() {
        guard let destinationCoordinate else { return }
        switch mode {
        case .best:
            loadRecommendations(near: destinationCoordinate)
        case .street:
            if let mapVisibleRegion {
                curbVM.refresh(in: mapVisibleRegion, force: true)
            } else {
                curbVM.refresh(near: destinationCoordinate, force: true)
            }
        case .garages:
            loadGarages(near: destinationCoordinate)
        }
    }

    private func recommendationCountdown(_ recommendation: ParkingRecommendation) -> String? {
        guard let raw = recommendation.nextChange else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let date else { return nil }
        let remaining = Int(date.timeIntervalSince(countdownNow))
        guard remaining > 0 else { return nil }
        return String(format: "%02d:%02d", remaining / 60, remaining % 60)
    }

    private func moveMapSheet(by offset: Int) {
        let nextValue = min(max(mapSheetPosition.rawValue + offset, 0), MapSheetPosition.allCases.count - 1)
        guard let next = MapSheetPosition(rawValue: nextValue) else { return }
        withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
            mapSheetPosition = next
            mapSheetDragOffset = 0
        }
    }

    private var mapStatusToast: some View {
        Text(mapStatusText)
            .font(.caption2.weight(.medium))
            .foregroundStyle(AppTheme.ink.opacity(0.8))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(AppTheme.cloud.opacity(0.9), in: Capsule())
            .overlay(Capsule().stroke(AppTheme.action.opacity(0.18), lineWidth: 1))
            .allowsHitTesting(false)
    }

    private var mapStatusText: String {
        if mode == .best {
            return recommendationStatus ?? "Advisory interval-aware parking options"
        }
        if mode == .street {
            return curbVM.sourceLabel
        }
        if let garageStatus, !garageStatus.isEmpty {
            return garageStatus
        }
        return "\(garages.count) active licensed facilities nearby"
    }

    @ViewBuilder
    private var mapContextOverlay: some View {
        switch mapOverlayState {
        case .collapsed:
            nearbyResultsButton
        case .browsing:
            nearbyResultsDrawer
        case .selected:
            if mode == .street, let segment = selectedStreet {
                ParkingPopup(
                    segment: segment,
                    nextChange: nextChangeDate(for: segment, reference: countdownNow),
                    countdownText: countdownText(for: segment, now: countdownNow),
                    onClose: dismissMapOverlay
                )
            } else if mode == .garages, let garage = selectedGarage {
                GaragePopup(garage: garage, onClose: dismissMapOverlay)
            } else {
                nearbyResultsButton
            }
        }
    }

    private var nearbyResultsButton: some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) {
                mapOverlayState = .browsing
            }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "list.bullet")
                    .font(.caption.weight(.bold))
                Text(mode == .street ? "Nearby curbs" : "Nearby garages")
                    .font(.subheadline.weight(.semibold))
                Text("\(mode == .street ? curbVM.segments.count : garages.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.ink)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 26)
                    .background(AppTheme.breeze, in: Capsule())
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .background(AppTheme.ink.opacity(0.94), in: Capsule())
            .shadow(color: AppTheme.ink.opacity(0.25), radius: 10, y: 5)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show nearby \(mode == .street ? "curbs" : "garages")")
    }

    private var nearbyResultsDrawer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("NEARBY")
                        .font(.caption2.weight(.bold))
                        .tracking(1)
                        .foregroundStyle(.secondary)
                    Text(mode == .street ? "Street parking" : "Garages")
                        .font(.headline)
                }

                Spacer()

                Text("\(mode == .street ? curbVM.segments.count : garages.count)")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 9)
                    .frame(minHeight: 28)
                    .background(AppTheme.breeze.opacity(0.75), in: Capsule())

                Button {
                    dismissMapOverlay()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 30, height: 30)
                        .background(AppTheme.breeze.opacity(0.62), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close nearby results")
            }

            if mode == .street {
                streetOptionsPanel
            } else {
                garageOptionsPanel
            }
        }
        .padding(14)
        .frame(maxWidth: 420)
        .background(AppTheme.cloud.opacity(0.98), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(AppTheme.action.opacity(0.22), lineWidth: 1)
        )
        .shadow(color: AppTheme.ink.opacity(0.2), radius: 12, y: 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var zoomControls: some View {
        VStack(spacing: 8) {
            Button {
                zoomMap(factor: 0.72)
            } label: {
                ZStack {
                    Circle()
                        .fill(AppTheme.cloud.opacity(0.94))
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(AppTheme.ink)
                }
                .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Zoom in")

            Button {
                zoomMap(factor: 1.38)
            } label: {
                ZStack {
                    Circle()
                        .fill(AppTheme.cloud.opacity(0.94))
                    Image(systemName: "minus")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(AppTheme.ink)
                }
                .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Zoom out")
        }
    }

    @MapContentBuilder
    private var streetMapLayer: some MapContent {
        ForEach(curbVM.segments) { segment in
            MapPolyline(coordinates: segment.coordinates)
                .stroke(Color.white.opacity(0.92), lineWidth: selectedStreet?.id == segment.id ? 13 : 10)
                .mapOverlayLevel(level: .aboveRoads)

            MapPolyline(coordinates: segment.coordinates)
                .stroke(segment.status.color, lineWidth: selectedStreet?.id == segment.id ? 10 : 7)
                .mapOverlayLevel(level: .aboveRoads)

            if let countdown = countdownText(for: segment, now: countdownNow) {
                Annotation("", coordinate: midpoint(of: segment.coordinates)) {
                    countdownBadge(countdown, status: segment.status)
                }
            }
        }

        ForEach(hydrantNoParkingSegments) { blocked in
            MapPolyline(coordinates: blocked.coordinates)
                .stroke(Color.red.opacity(0.96), lineWidth: 9)
                .mapOverlayLevel(level: .aboveRoads)
        }
    }

    private var recommendationMapLayer: some MapContent {
        ForEach(recommendations) { recommendation in
            Annotation(recommendation.title, coordinate: recommendation.coordinate) {
                Button {
                    selectRecommendation(recommendation)
                } label: {
                    BestRecommendationMarker(
                        color: recommendation.statusColor,
                        isBest: recommendations.first?.id == recommendation.id,
                        isSelected: selectedRecommendation?.id == recommendation.id
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(recommendations.first?.id == recommendation.id ? "Best parking lead" : "Parking option"): \(recommendation.title), \(recommendation.tierLabel)")
            }
        }
    }

    private var hydrantMapLayer: some MapContent {
        ForEach(hydrants) { hydrant in
            Annotation("", coordinate: hydrant.coordinate) {
                hydrantMarker
            }
        }
    }

    private var hydrantMarker: some View {
        Image("HydrantLogo")
            .resizable()
            .renderingMode(.original)
            .scaledToFit()
            .frame(width: 16, height: 16)
            .shadow(color: Color.black.opacity(0.18), radius: 1.4, x: 0, y: 1)
        .accessibilityHidden(true)
    }

    private var garageMapLayer: some MapContent {
        ForEach(garages) { garage in
            Annotation(garage.name, coordinate: garage.coordinate) {
                Button {
                    selectGarage(garage)
                } label: {
                    Image(systemName: selectedGarage?.id == garage.id ? "car.circle.fill" : "car.circle")
                        .font(.title3)
                        .foregroundStyle(selectedGarage?.id == garage.id ? AppTheme.action : AppTheme.ink)
                        .padding(6)
                        .background(
                            Circle()
                                .fill(AppTheme.cloud.opacity(0.9))
                                .overlay(
                                    Circle()
                                        .stroke(AppTheme.action.opacity(0.25), lineWidth: 1)
                                )
                        )
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Select garage \(garage.name)")
            }
        }
    }

    private var streetOptionsPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            if curbVM.segments.isEmpty {
                if curbVM.sourceLabel.contains("no nearby rows") {
                    Text("No nearby NYC street rows found at this destination.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Loading street parking…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(curbVM.segments) { segment in
                            Button {
                                selectStreet(segment)
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Circle()
                                        .fill(segment.status.color)
                                        .frame(width: 10, height: 10)
                                        .padding(.top, 6)

                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text(segment.name)
                                                .font(.subheadline)
                                                .bold()
                                            Spacer()
                                            Text(segment.status.title)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }

                                        Text(segment.explanation)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                }
                            }
                            .buttonStyle(.plain)

                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
        }
    }

    private func countdownBadge(_ text: String, status: ParkingStatus) -> some View {
        Text(text)
            .font(.caption2.monospacedDigit().weight(.semibold))
            .foregroundStyle(status == .caution ? .black : .white)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(status.color.opacity(0.9))
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(Color.black.opacity(0.15), lineWidth: 0.8)
            )
    }

    private var garageOptionsPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Active licensed facilities")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if isLoadingGarages {
                    ProgressView()
                        .scaleEffect(0.8)
                }
            }

            if let garageStatus {
                Text(garageStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if garages.isEmpty {
                Text(isLoadingGarages ? "Loading licensed facilities…" : "No active licensed facilities found yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(garages) { garage in
                            Button {
                                selectGarage(garage)
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: selectedGarage?.id == garage.id ? "car.circle.fill" : "car.circle")
                                        .foregroundStyle(selectedGarage?.id == garage.id ? .blue : .secondary)
                                        .padding(.top, 2)

                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(garage.name)
                                            .font(.subheadline)
                                            .bold()
                                            .foregroundStyle(.primary)

                                        Text(garage.address)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)

                                        HStack(spacing: 10) {
                                            Text(garage.distanceText)
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)

                                            if let phoneNumber = garage.phoneNumber,
                                               !phoneNumber.isEmpty {
                                                Text(phoneNumber)
                                                    .font(.caption2)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }

                                        if let licenseNumber = garage.licenseNumber {
                                            Text("NYC DCWP license \(licenseNumber)")
                                                .font(.caption2.weight(.semibold))
                                                .foregroundStyle(AppTheme.ink.opacity(0.7))
                                        }
                                    }

                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)

                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 240)
            }
        }
    }

    private func applySuggestion(_ suggestion: MKLocalSearchCompletion) {
        let suggestionText = locationSuggestions.formattedText(for: suggestion)
        searchText = suggestionText
        pendingSuggestion = suggestion
        locationSuggestions.clear()
        searchStatus = nil
    }

    private func goToSelectedDestinationFromLanding() {
        guard !isSearchingDestination else { return }

        if let pendingSuggestion {
            resolveSuggestionAndApply(pendingSuggestion)
            return
        }

        beginDestinationSearch()
    }

    private func resolveSuggestionAndApply(_ suggestion: MKLocalSearchCompletion) {
        let suggestionText = locationSuggestions.formattedText(for: suggestion)
        isSearchingDestination = true
        searchStatus = nil

        Task {
            do {
                let item = try await lookupDestination(completion: suggestion)
                await MainActor.run {
                    applyDestination(item: item, fallbackName: suggestionText)
                    isSearchingDestination = false
                    pendingSuggestion = nil
                }
            } catch {
                do {
                    let item = try await lookupDestination(query: suggestionText)
                    await MainActor.run {
                        applyDestination(item: item, fallbackName: suggestionText)
                        isSearchingDestination = false
                        pendingSuggestion = nil
                    }
                } catch DestinationLookupError.noResults {
                    await MainActor.run {
                        searchStatus = "No destination found for that address."
                        isSearchingDestination = false
                    }
                } catch {
                    await MainActor.run {
                        searchStatus = "Search failed: \(error.localizedDescription)"
                        isSearchingDestination = false
                    }
                }
            }
        }
    }

    private func beginDestinationSearch() {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }

        pendingSuggestion = nil
        locationSuggestions.clear()
        isSearchingDestination = true
        searchStatus = nil

        Task {
            do {
                let item = try await lookupDestination(query: query)
                await MainActor.run {
                    applyDestination(item: item, fallbackName: query)
                    isSearchingDestination = false
                }
            } catch DestinationLookupError.noResults {
                await MainActor.run {
                    searchStatus = "No destination found for that address."
                    isSearchingDestination = false
                }
            } catch {
                await MainActor.run {
                    searchStatus = "Search failed: \(error.localizedDescription)"
                    isSearchingDestination = false
                }
            }
        }
    }

    private func lookupDestination(query: String) async throws -> MKMapItem {
        if let item = try await runSearch(query: query, region: nil) {
            return item
        }

        let nycRegion = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 40.7128, longitude: -74.0060),
            span: MKCoordinateSpan(latitudeDelta: 0.9, longitudeDelta: 0.9)
        )

        if let item = try await runSearch(query: query, region: nycRegion) {
            return item
        }

        if let item = try await geocodeAddress(query: query, region: nycRegion) {
            return item
        }

        throw DestinationLookupError.noResults
    }

    private func lookupDestination(completion: MKLocalSearchCompletion) async throws -> MKMapItem {
        let request = MKLocalSearch.Request(completion: completion)
        let response = try await MKLocalSearch(request: request).start()
        if let first = response.mapItems.first {
            return first
        }
        throw DestinationLookupError.noResults
    }

    private func runSearch(query: String, region: MKCoordinateRegion?) async throws -> MKMapItem? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.resultTypes = [.address, .pointOfInterest]
        if let region {
            request.region = region
        }

        let response = try await MKLocalSearch(request: request).start()
        return response.mapItems.first
    }

    private func geocodeAddress(query: String, region: MKCoordinateRegion) async throws -> MKMapItem? {
        let geocoder = CLGeocoder()
        let placemarks = try await geocoder.geocodeAddressString(query)
        guard let coordinate = placemarks
            .compactMap({ $0.location?.coordinate })
            .first(where: { region.contains($0) }) ?? placemarks.first?.location?.coordinate else {
            return nil
        }
        return MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
    }

    private func applyDestination(item: MKMapItem, fallbackName: String) {
        let coordinate = item.placemark.coordinate
        guard CLLocationCoordinate2DIsValid(coordinate) else {
            searchStatus = "Selected destination has no valid coordinates."
            return
        }

        destinationCoordinate = coordinate
        mapCenterCoordinate = coordinate
        destinationName = item.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? fallbackName
        pendingSuggestion = nil
        mode = .best
        mapOverlayState = .collapsed
        mapSheetPosition = .half
        mapSheetDragOffset = 0
        appStage = .results

        selectedStreet = nil
        selectedGarage = nil
        selectedRecommendation = nil
        recommendations = []
        recommendationAvailability = nil
        recommendationStatus = "Checking advisory parking options…"
        garages = []
        garageStatus = allowGarages ? "Loading licensed facilities…" : nil

        let destinationRegion = MKCoordinateRegion(
            center: coordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
        )
        mapVisibleRegion = destinationRegion
        position = .region(destinationRegion)

        curbVM.setEvaluationInterval(start: arrivalDate, end: departureDate)
        initializeHydrantVisibilityThresholdIfNeeded(for: destinationRegion, reset: true)
        curbVM.refresh(in: destinationRegion, force: true)
        refreshHydrants(for: destinationRegion, force: true)
        loadRecommendations(near: coordinate)
        if allowGarages {
            loadGarages(near: coordinate)
        }
    }

    private func loadRecommendations(near coordinate: CLLocationCoordinate2D) {
        recommendationTask?.cancel()
        let requestedArrival = arrivalDate
        let requestedDeparture = departureDate
        let preferences = ParkingRecommendationPreferences(
            allowPaid: allowPaidParking,
            allowGarages: allowGarages,
            maxWalkMinutes: maxWalkMinutes,
            allowTransit: false,
            accessibleOnly: false
        )

        isLoadingRecommendations = true
        recommendationStatus = "Checking advisory parking options…"
        recommendationTask = Task {
            do {
                let response = try await recommendationService.fetchRecommendations(
                    near: coordinate,
                    arrival: requestedArrival,
                    departure: requestedDeparture,
                    preferences: preferences
                )
                await MainActor.run {
                    guard !Task.isCancelled,
                          isSameCoordinate(lhs: destinationCoordinate, rhs: coordinate),
                          arrivalDate == requestedArrival,
                          departureDate == requestedDeparture else { return }
                    recommendations = response.options
                    recommendationAvailability = response.availability
                    let warning = response.warnings.first?.message
                    recommendationStatus = response.options.isEmpty
                        ? (warning ?? "No eligible options match this complete interval.")
                        : (warning ?? "Advisory ranking · verify posted signs")
                    isLoadingRecommendations = false
                    if let best = response.options.first {
                        selectRecommendation(best)
                    }
                }
            } catch is CancellationError {
                await MainActor.run {
                    isLoadingRecommendations = false
                }
            } catch {
                await MainActor.run {
                    guard !Task.isCancelled,
                          isSameCoordinate(lhs: destinationCoordinate, rhs: coordinate) else { return }
                    recommendationStatus = recommendations.isEmpty
                        ? "Recommendation request failed: \(error.localizedDescription)"
                        : "Previously loaded recommendations · refresh failed"
                    isLoadingRecommendations = false
                }
            }
        }
    }

    private func loadGarages(near coordinate: CLLocationCoordinate2D) {
        isLoadingGarages = true
        garageStatus = "Loading licensed facilities…"

        Task {
            do {
                let result = try await facilityService.fetchLicensedFacilities(near: coordinate)
                await MainActor.run {
                    guard isSameCoordinate(lhs: destinationCoordinate, rhs: coordinate) else { return }

                    garages = result
                    isLoadingGarages = false
                    garageStatus = result.isEmpty ? "No active licensed facilities found near this destination." : "Active NYC DCWP licensed facilities"
                }
            } catch {
                await MainActor.run {
                    guard isSameCoordinate(lhs: destinationCoordinate, rhs: coordinate) else { return }

                    garages = []
                    isLoadingGarages = false
                    garageStatus = "Licensed-facility lookup failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func refreshHydrants(for region: MKCoordinateRegion, force: Bool = false) {
        guard mode != .garages else {
            clearHydrants()
            return
        }
        guard shouldShowHydrants(in: region) else {
            clearHydrants()
            return
        }

        let center = region.center
        guard CLLocationCoordinate2DIsValid(center) else {
            clearHydrants()
            return
        }

        let radiusMeters = hydrantRadiusMeters(for: region)
        if !force && shouldSkipHydrantRefresh(center: center, radiusMeters: radiusMeters) {
            return
        }

        hydrantFetchTask?.cancel()
        hydrantFetchTask = Task {
            do {
                let fetchedCoordinates = try await hydrantService.fetchHydrantCoordinates(in: region)
                await MainActor.run {
                    guard !Task.isCancelled else { return }
                    hydrants = fetchedCoordinates.enumerated().map { index, coordinate in
                        HydrantPoint(
                            id: String(format: "%d-%.6f-%.6f", index, coordinate.latitude, coordinate.longitude),
                            coordinate: coordinate
                        )
                    }
                    lastHydrantFetchCenter = center
                    lastHydrantFetchDate = Date()
                    lastHydrantFetchRadiusMeters = radiusMeters
                    recalculateHydrantNoParkingSegments()
                }
            } catch is CancellationError {
                return
            } catch {
                await MainActor.run {
                    guard !Task.isCancelled else { return }
                    hydrants = []
                    lastHydrantFetchCenter = center
                    lastHydrantFetchDate = Date()
                    lastHydrantFetchRadiusMeters = radiusMeters
                    recalculateHydrantNoParkingSegments()
                }
            }
        }
    }

    private func clearHydrants() {
        hydrantFetchTask?.cancel()
        hydrantFetchTask = nil
        hydrants = []
        hydrantNoParkingSegments = []
        lastHydrantFetchCenter = nil
        lastHydrantFetchDate = nil
        lastHydrantFetchRadiusMeters = nil
    }

    private func shouldShowHydrants(in region: MKCoordinateRegion) -> Bool {
        initializeHydrantVisibilityThresholdIfNeeded(for: region)
        guard let threshold = hydrantVisibilityShortEdgeThresholdMeters else { return false }
        let shortEdgeMeters = visibleShortEdgeMeters(for: region)
        return shortEdgeMeters <= threshold
    }

    private func hydrantRadiusMeters(for region: MKCoordinateRegion) -> Int {
        let shortEdgeMeters = visibleShortEdgeMeters(for: region)
        let visibleCircle = shortEdgeMeters / 2
        let padded = visibleCircle + 30
        let clamped = max(120, min(500, padded))
        return Int(clamped.rounded(.up))
    }

    private func visibleShortEdgeMeters(for region: MKCoordinateRegion) -> Double {
        let latMeters = max(region.span.latitudeDelta, 0.0008) * 111_320
        let latRadians = region.center.latitude * .pi / 180
        let lonScale = max(cos(latRadians), 0.2)
        let lonMeters = max(region.span.longitudeDelta, 0.0008) * 111_320 * lonScale
        return min(latMeters, lonMeters)
    }

    private func shouldSkipHydrantRefresh(center: CLLocationCoordinate2D, radiusMeters: Int) -> Bool {
        guard let lastCenter = lastHydrantFetchCenter,
              let lastFetchedAt = lastHydrantFetchDate,
              let lastRadius = lastHydrantFetchRadiusMeters else {
            return false
        }

        let elapsed = Date().timeIntervalSince(lastFetchedAt)
        if elapsed > 3.5 {
            return false
        }

        let previous = CLLocation(latitude: lastCenter.latitude, longitude: lastCenter.longitude)
        let current = CLLocation(latitude: center.latitude, longitude: center.longitude)
        let movedMeters = previous.distance(from: current)
        if movedMeters > max(35, Double(radiusMeters) * 0.25) {
            return false
        }

        let radiusShift = abs(Double(radiusMeters - lastRadius)) / Double(max(lastRadius, 1))
        return radiusShift < 0.22
    }

    private func recalculateHydrantNoParkingSegments(segments _: [CurbSegment]? = nil) {
        // DOT-approved curb-side linkage is not available yet. Hydrant points may be
        // shown for context, but the client must not manufacture red curb geometry.
        hydrantNoParkingSegments = []
    }

    private func snapHydrantToNearestSegment(
        _ coordinate: CLLocationCoordinate2D,
        segments: [CurbSegment],
        maxDistanceMeters: CLLocationDistance
    ) -> (segment: CurbSegment, distanceAlongMeters: Double)? {
        guard CLLocationCoordinate2DIsValid(coordinate) else { return nil }

        let targetPoint = MKMapPoint(coordinate)
        let targetLocation = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        var bestSegment: CurbSegment?
        var bestDistanceMeters = Double.greatestFiniteMagnitude
        var bestDistanceAlongMeters = 0.0

        for segment in segments {
            let coordinates = segment.coordinates
            guard coordinates.count >= 2 else { continue }

            var traversedMeters = 0.0
            for index in 1..<coordinates.count {
                let startCoordinate = coordinates[index - 1]
                let endCoordinate = coordinates[index]
                let startPoint = MKMapPoint(startCoordinate)
                let endPoint = MKMapPoint(endCoordinate)

                let dx = endPoint.x - startPoint.x
                let dy = endPoint.y - startPoint.y
                if dx == 0 && dy == 0 {
                    continue
                }

                let projection = ((targetPoint.x - startPoint.x) * dx + (targetPoint.y - startPoint.y) * dy) / ((dx * dx) + (dy * dy))
                let clamped = max(0, min(1, projection))
                let projectedCoordinate = interpolateCoordinate(
                    from: startCoordinate,
                    to: endCoordinate,
                    fraction: clamped
                )
                let projectedLocation = CLLocation(
                    latitude: projectedCoordinate.latitude,
                    longitude: projectedCoordinate.longitude
                )
                let snappedDistanceMeters = targetLocation.distance(from: projectedLocation)
                let edgeLengthMeters = distanceMeters(between: startCoordinate, and: endCoordinate)
                let distanceAlongMeters = traversedMeters + (edgeLengthMeters * clamped)

                if snappedDistanceMeters < bestDistanceMeters {
                    bestDistanceMeters = snappedDistanceMeters
                    bestSegment = segment
                    bestDistanceAlongMeters = distanceAlongMeters
                }

                traversedMeters += edgeLengthMeters
            }
        }

        guard let bestSegment, bestDistanceMeters <= maxDistanceMeters else {
            return nil
        }
        return (bestSegment, bestDistanceAlongMeters)
    }

    private func clippedCoordinates(
        along coordinates: [CLLocationCoordinate2D],
        fromDistanceMeters start: Double,
        toDistanceMeters end: Double
    ) -> [CLLocationCoordinate2D] {
        guard coordinates.count >= 2 else { return [] }

        var segmentLengths: [Double] = []
        segmentLengths.reserveCapacity(max(0, coordinates.count - 1))
        var totalLengthMeters = 0.0

        for index in 1..<coordinates.count {
            let length = distanceMeters(between: coordinates[index - 1], and: coordinates[index])
            segmentLengths.append(length)
            totalLengthMeters += length
        }

        guard totalLengthMeters > 0 else { return [] }

        let clampedStart = max(0, min(start, totalLengthMeters))
        let clampedEnd = max(0, min(end, totalLengthMeters))
        guard clampedEnd > clampedStart else { return [] }

        var clipped: [CLLocationCoordinate2D] = []
        var traversedMeters = 0.0

        for index in 0..<segmentLengths.count {
            let edgeLengthMeters = segmentLengths[index]
            let edgeStart = traversedMeters
            let edgeEnd = traversedMeters + edgeLengthMeters
            defer { traversedMeters = edgeEnd }

            if edgeLengthMeters <= 0 || edgeEnd < clampedStart || edgeStart > clampedEnd {
                continue
            }

            let localStart = max(clampedStart, edgeStart)
            let localEnd = min(clampedEnd, edgeEnd)
            let startT = (localStart - edgeStart) / edgeLengthMeters
            let endT = (localEnd - edgeStart) / edgeLengthMeters
            let startCoordinate = interpolateCoordinate(
                from: coordinates[index],
                to: coordinates[index + 1],
                fraction: startT
            )
            let endCoordinate = interpolateCoordinate(
                from: coordinates[index],
                to: coordinates[index + 1],
                fraction: endT
            )

            appendCoordinateIfNeeded(startCoordinate, into: &clipped)
            appendCoordinateIfNeeded(endCoordinate, into: &clipped)
        }

        return clipped
    }

    private func appendCoordinateIfNeeded(
        _ coordinate: CLLocationCoordinate2D,
        into list: inout [CLLocationCoordinate2D]
    ) {
        guard let last = list.last else {
            list.append(coordinate)
            return
        }
        if coordinatesAlmostEqual(last, coordinate) {
            return
        }
        list.append(coordinate)
    }

    private func coordinatesAlmostEqual(
        _ lhs: CLLocationCoordinate2D,
        _ rhs: CLLocationCoordinate2D,
        tolerance: Double = 0.0000005
    ) -> Bool {
        abs(lhs.latitude - rhs.latitude) <= tolerance &&
        abs(lhs.longitude - rhs.longitude) <= tolerance
    }

    private func distanceMeters(
        between lhs: CLLocationCoordinate2D,
        and rhs: CLLocationCoordinate2D
    ) -> Double {
        CLLocation(latitude: lhs.latitude, longitude: lhs.longitude)
            .distance(from: CLLocation(latitude: rhs.latitude, longitude: rhs.longitude))
    }

    private func interpolateCoordinate(
        from start: CLLocationCoordinate2D,
        to end: CLLocationCoordinate2D,
        fraction: Double
    ) -> CLLocationCoordinate2D {
        let clamped = max(0, min(1, fraction))
        return CLLocationCoordinate2D(
            latitude: start.latitude + ((end.latitude - start.latitude) * clamped),
            longitude: start.longitude + ((end.longitude - start.longitude) * clamped)
        )
    }

    private func handleModeChange(_ newMode: ParkingMode) {
        guard let destinationCoordinate else { return }

        selectedStreet = nil
        selectedGarage = nil
        selectedRecommendation = nil
        mapOverlayState = .collapsed
        mapSheetPosition = .half

        if newMode == .best, let best = recommendations.first {
            selectRecommendation(best)
            return
        }

        if newMode != .garages {
            selectedGarage = nil
            mapCenterCoordinate = destinationCoordinate
            let region = MKCoordinateRegion(
                center: destinationCoordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
            )
            mapVisibleRegion = region
            initializeHydrantVisibilityThresholdIfNeeded(for: region)
            curbVM.refresh(in: region, force: true)
            refreshHydrants(for: region, force: true)
            if newMode == .best && recommendations.isEmpty {
                loadRecommendations(near: destinationCoordinate)
            }
            position = .region(region)
        } else {
            selectedStreet = nil
            clearHydrants()
            if garages.isEmpty {
                loadGarages(near: destinationCoordinate)
            }
            position = .region(
                MKCoordinateRegion(
                    center: destinationCoordinate,
                    span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
                )
            )
        }
    }

    private func nextChangeDate(for segment: CurbSegment, reference: Date) -> Date? {
        guard let explicit = segment.nextChange, explicit > reference else { return nil }
        return explicit
    }

    private func countdownText(for segment: CurbSegment, now: Date) -> String? {
        guard let nextChange = nextChangeDate(for: segment, reference: now) else { return nil }
        let remaining = Int(nextChange.timeIntervalSince(now))
        guard remaining > 0, remaining <= 3600 else { return nil }

        let minutes = remaining / 60
        let seconds = remaining % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    private func focusOnBestParking() {
        if let best = recommendations.first {
            mode = .best
            selectRecommendation(best)
            return
        }

        guard let destinationCoordinate else { return }
        selectedStreet = nil
        selectedGarage = nil
        selectedRecommendation = nil
        mapOverlayState = .collapsed
        mapSheetPosition = .half
        mapCenterCoordinate = destinationCoordinate
        let region = MKCoordinateRegion(
            center: destinationCoordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
        )
        mapVisibleRegion = region
        position = .region(region)
    }

    private var plannedParkingWindowText: String {
        let dateFormatter = DateFormatter()
        dateFormatter.timeZone = TimeZone(identifier: "America/New_York")
        dateFormatter.dateFormat = "MMM d"

        let timeFormatter = DateFormatter()
        timeFormatter.timeZone = TimeZone(identifier: "America/New_York")
        timeFormatter.timeStyle = .short
        timeFormatter.dateStyle = .none

        return "\(dateFormatter.string(from: arrivalDate)), \(timeFormatter.string(from: arrivalDate))–\(timeFormatter.string(from: departureDate))"
    }

    private func zoomMap(factor: Double) {
        guard factor > 0 else { return }
        dismissMapOverlay()

        let center = (mapVisibleRegion?.center) ?? mapCenterCoordinate ?? destinationCoordinate
        guard let center, CLLocationCoordinate2DIsValid(center) else { return }

        let baselineSpan = mapVisibleRegion?.span ?? MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
        let minDelta = 0.0006
        let maxDelta = 1.2
        let nextLat = min(max(baselineSpan.latitudeDelta * factor, minDelta), maxDelta)
        let nextLon = min(max(baselineSpan.longitudeDelta * factor, minDelta), maxDelta)

        let nextRegion = MKCoordinateRegion(
            center: center,
            span: MKCoordinateSpan(latitudeDelta: nextLat, longitudeDelta: nextLon)
        )

        mapCenterCoordinate = center
        mapVisibleRegion = nextRegion
        position = .region(nextRegion)

        if mode != .garages {
            curbVM.refresh(in: nextRegion)
            refreshHydrants(for: nextRegion)
        }
    }

    private func handleStreetTap(at coordinate: CLLocationCoordinate2D) {
        guard let tappedSegment = nearestStreetSegment(to: coordinate, maxDistanceMeters: 38) else {
            dismissMapOverlay()
            return
        }
        selectStreet(tappedSegment)
    }

    private func handleGarageTap(at coordinate: CLLocationCoordinate2D) {
        let tapLocation = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        let nearest = garages
            .map { garage in
                (
                    garage: garage,
                    distance: tapLocation.distance(
                        from: CLLocation(
                            latitude: garage.coordinate.latitude,
                            longitude: garage.coordinate.longitude
                        )
                    )
                )
            }
            .filter { $0.distance <= 45 }
            .min { $0.distance < $1.distance }

        if let nearest {
            selectGarage(nearest.garage)
        } else {
            dismissMapOverlay()
        }
    }

    private func nearestStreetSegment(to coordinate: CLLocationCoordinate2D, maxDistanceMeters: CLLocationDistance) -> CurbSegment? {
        let tapPoint = MKMapPoint(coordinate)
        var winner: (segment: CurbSegment, distance: CLLocationDistance)?

        for segment in curbVM.segments {
            let distance = distanceFrom(point: tapPoint, toPolyline: segment.coordinates)
            guard distance <= maxDistanceMeters else { continue }

            if let winner, winner.distance <= distance {
                continue
            }
            winner = (segment, distance)
        }

        return winner?.segment
    }

    private func distanceFrom(point: MKMapPoint, toPolyline coordinates: [CLLocationCoordinate2D]) -> CLLocationDistance {
        guard coordinates.count >= 2 else {
            guard let only = coordinates.first else { return .greatestFiniteMagnitude }
            let onlyPoint = MKMapPoint(only)
            let mapDistance = hypot(point.x - onlyPoint.x, point.y - onlyPoint.y)
            return mapDistance * MKMetersPerMapPointAtLatitude(only.latitude)
        }

        var minimumMapDistance = Double.greatestFiniteMagnitude
        for index in 1..<coordinates.count {
            let start = MKMapPoint(coordinates[index - 1])
            let end = MKMapPoint(coordinates[index])
            let candidate = distanceFrom(point: point, toSegmentStart: start, toSegmentEnd: end)
            minimumMapDistance = min(minimumMapDistance, candidate)
        }

        let metersPerPoint = MKMetersPerMapPointAtLatitude(coordinates[0].latitude)
        return minimumMapDistance * metersPerPoint
    }

    private func distanceFrom(point: MKMapPoint, toSegmentStart start: MKMapPoint, toSegmentEnd end: MKMapPoint) -> Double {
        let dx = end.x - start.x
        let dy = end.y - start.y
        if dx == 0 && dy == 0 {
            return hypot(point.x - start.x, point.y - start.y)
        }

        let projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / ((dx * dx) + (dy * dy))
        let clamped = max(0, min(1, projection))
        let projectedX = start.x + clamped * dx
        let projectedY = start.y + clamped * dy
        return hypot(point.x - projectedX, point.y - projectedY)
    }

    private func selectStreet(_ segment: CurbSegment) {
        selectedStreet = segment
        selectedGarage = nil
        selectedRecommendation = nil
        mapOverlayState = .selected
        mapSheetPosition = .half

        let center = midpoint(of: segment.coordinates)
        mapCenterCoordinate = center
        let region = MKCoordinateRegion(
            center: center,
            span: MKCoordinateSpan(latitudeDelta: 0.006, longitudeDelta: 0.006)
        )
        mapVisibleRegion = region
        position = .region(region)
    }

    private func selectGarage(_ garage: GarageOption) {
        selectedGarage = garage
        selectedStreet = nil
        selectedRecommendation = nil
        mapOverlayState = .selected
        mapSheetPosition = .half

        position = .region(
            MKCoordinateRegion(
                center: garage.coordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
            )
        )
    }

    private func selectRecommendation(_ recommendation: ParkingRecommendation) {
        selectedRecommendation = recommendation
        selectedStreet = nil
        selectedGarage = nil
        mapOverlayState = .selected
        mapSheetPosition = .half
        mapCenterCoordinate = recommendation.coordinate

        let region = MKCoordinateRegion(
            center: recommendation.coordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.006, longitudeDelta: 0.006)
        )
        mapVisibleRegion = region
        position = .region(region)
    }

    private func resetToLanding() {
        appStage = .landing
        mode = .best
        mapOverlayState = .collapsed
        mapSheetPosition = .half

        selectedStreet = nil
        selectedGarage = nil
        selectedRecommendation = nil
        recommendations = []
        recommendationAvailability = nil
        recommendationStatus = nil
        recommendationTask?.cancel()
        recommendationTask = nil
        garages = []
        garageStatus = nil

        destinationName = ""
        destinationCoordinate = nil
        mapCenterCoordinate = nil
        mapVisibleRegion = nil
        pendingSuggestion = nil
        searchStatus = nil
        isSearchingDestination = false
        clearHydrants()
        hydrantVisibilityShortEdgeThresholdMeters = nil

        position = .automatic
    }

    private func dismissMapOverlay() {
        guard mapOverlayState != .collapsed || selectedStreet != nil || selectedGarage != nil || selectedRecommendation != nil else {
            withAnimation(.easeOut(duration: 0.18)) {
                mapSheetPosition = .minimized
            }
            return
        }
        withAnimation(.easeOut(duration: 0.18)) {
            mapOverlayState = .collapsed
            selectedStreet = nil
            selectedGarage = nil
            selectedRecommendation = nil
            mapSheetPosition = .minimized
        }
    }

    private func isSameCoordinate(lhs: CLLocationCoordinate2D?, rhs: CLLocationCoordinate2D) -> Bool {
        guard let lhs else { return false }
        let latDiff = abs(lhs.latitude - rhs.latitude)
        let lonDiff = abs(lhs.longitude - rhs.longitude)
        return latDiff < 0.0001 && lonDiff < 0.0001
    }

    private func initializeHydrantVisibilityThresholdIfNeeded(
        for region: MKCoordinateRegion,
        reset: Bool = false
    ) {
        if reset {
            hydrantVisibilityShortEdgeThresholdMeters = nil
        }
        guard hydrantVisibilityShortEdgeThresholdMeters == nil else { return }

        let initialShortEdgeMeters = visibleShortEdgeMeters(for: region)
        guard initialShortEdgeMeters.isFinite, initialShortEdgeMeters > 0 else { return }

        let zoomMultiplier = pow(hydrantZoomInStepFactor, Double(hydrantZoomInStepsRequired))
        hydrantVisibilityShortEdgeThresholdMeters = initialShortEdgeMeters * zoomMultiplier
    }
}

private enum PaidHoursTransitionEstimator {
    private static let nyTimeZone = TimeZone(identifier: "America/New_York") ?? .current
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = nyTimeZone
        return calendar
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

    static func nextTransition(after now: Date, rawText: String?) -> Date? {
        guard let rawText else { return nil }
        let text = normalize(rawText)
        if text.isEmpty || text == "N/A" {
            return nil
        }

        if text.contains("ANYTIME") && !text.contains("EXCEPT") {
            return nil
        }

        let fallbackDays = parseDays(from: text)
        let clauses = text.split(whereSeparator: { $0 == "," || $0 == ";" }).map(String.init)
        let startOfToday = calendar.startOfDay(for: now)
        var candidates: [Date] = []

        for dayOffset in 0...8 {
            guard let dayStart = calendar.date(byAdding: .day, value: dayOffset, to: startOfToday) else {
                continue
            }

            let weekday = calendar.component(.weekday, from: dayStart)

            for clause in clauses {
                let ranges = parseTimeRanges(from: clause)
                guard !ranges.isEmpty else { continue }

                let clauseDays = parseDays(from: clause)
                let activeDays = clauseDays.isEmpty ? fallbackDays : clauseDays
                let daySet = activeDays.isEmpty ? Set(1...7) : activeDays
                guard daySet.contains(weekday) else { continue }

                for range in ranges {
                    if let startDate = date(for: dayStart, minuteOfDay: range.start) {
                        candidates.append(startDate)
                    }
                    if let endDate = endDate(for: range, dayStart: dayStart) {
                        candidates.append(endDate)
                    }
                }
            }
        }

        return candidates
            .filter { $0 > now }
            .sorted()
            .first
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
            guard let start = parseMinuteOfDay(from: startToken),
                  let end = parseMinuteOfDay(from: endToken) else {
                return nil
            }
            return MinuteRange(start: start, end: end)
        }
    }

    private static func parseMinuteOfDay(from token: String) -> Int? {
        let compact = token
            .uppercased()
            .replacingOccurrences(of: " ", with: "")
        let regex = try! NSRegularExpression(pattern: #"^(\d{1,2})(?::(\d{2}))?(AM|PM)$"#)
        let nsText = compact as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        guard let match = regex.firstMatch(in: compact, options: [], range: fullRange) else {
            return nil
        }

        guard let hour = Int(nsText.substring(with: match.range(at: 1))) else {
            return nil
        }

        let minute: Int
        if match.range(at: 2).location != NSNotFound {
            minute = Int(nsText.substring(with: match.range(at: 2))) ?? 0
        } else {
            minute = 0
        }

        let ampm = nsText.substring(with: match.range(at: 3))
        var hour24 = hour % 12
        if ampm == "PM" {
            hour24 += 12
        }

        return hour24 * 60 + minute
    }

    private static func date(for dayStart: Date, minuteOfDay: Int) -> Date? {
        calendar.date(byAdding: .minute, value: minuteOfDay, to: dayStart)
    }

    private static func endDate(for range: MinuteRange, dayStart: Date) -> Date? {
        guard range.start != range.end else { return nil }
        if range.end > range.start {
            return date(for: dayStart, minuteOfDay: range.end)
        }
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
            return nil
        }
        return date(for: tomorrow, minuteOfDay: range.end)
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
    }
}

private struct PidgeBrandMark: View {
    var body: some View {
        VStack(spacing: 4) {
            Text("NYC Parking Planner")
                .font(.system(size: 28, weight: .heavy, design: .rounded))
                .foregroundStyle(AppTheme.ink)

            Text("Where are you going?")
                .font(.headline)
                .foregroundStyle(AppTheme.ink.opacity(0.78))

            Image("PigeonLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 116, height: 116)
                .opacity(0.7)

            Text("Pidge can help explain your options. Posted signs remain the authority.")
                .font(.caption2)
                .foregroundStyle(AppTheme.ink.opacity(0.66))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct AnimatedLandingBackground: View {
    @State private var sweepProgress: CGFloat = 0
    @State private var breathIntensity: Double = 0

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [AppTheme.breeze.opacity(0.95), AppTheme.cloud.opacity(0.87), AppTheme.haze.opacity(0.89), AppTheme.breeze.opacity(0.9)],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )
            .saturation(1.02 + (0.2 * breathIntensity))
            .brightness(-0.035 + (0.08 * breathIntensity))
            .animation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true), value: breathIntensity)

            RadialGradient(
                colors: [AppTheme.breeze.opacity(0.2 + (0.38 * breathIntensity)), .clear],
                center: UnitPoint(x: 0.83, y: 0.2),
                startRadius: 50,
                endRadius: 560
            )
            .scaleEffect(0.9 + (0.22 * breathIntensity))
            .blur(radius: 10)
            .animation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true), value: breathIntensity)

            RadialGradient(
                colors: [AppTheme.haze.opacity(0.14 + (0.24 * breathIntensity)), .clear],
                center: UnitPoint(x: 0.2, y: 0.82),
                startRadius: 60,
                endRadius: 620
            )
            .blendMode(.softLight)
            .scaleEffect(1.12 - (0.18 * breathIntensity))
            .animation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true), value: breathIntensity)

            sweepBand(progress: sweepProgress, opacity: 0.76, width: 980, height: 340, blur: 18)
            sweepBand(progress: wrapped(progress: sweepProgress + 0.46), opacity: 0.44, width: 820, height: 290, blur: 24)
        }
        .ignoresSafeArea()
        .onAppear {
            sweepProgress = 0
            breathIntensity = 0

            withAnimation(.linear(duration: 6.1).repeatForever(autoreverses: false)) {
                sweepProgress = 1
            }
            withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) {
                breathIntensity = 1
            }
        }
    }

    @ViewBuilder
    private func sweepBand(
        progress: CGFloat,
        opacity: Double,
        width: CGFloat,
        height: CGFloat,
        blur: CGFloat
    ) -> some View {
        let x = CGFloat(540) - (CGFloat(1080) * progress)
        let y = CGFloat(-540) + (CGFloat(1080) * progress)

        LinearGradient(
            colors: [Color.white.opacity(0.42), AppTheme.action.opacity(0.24), .clear],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(width: width, height: height)
        .rotationEffect(.degrees(-34))
        .offset(x: x, y: y)
        .blur(radius: blur)
        .blendMode(.screen)
        .opacity(opacity)
    }

    private func wrapped(progress: CGFloat) -> CGFloat {
        progress >= 1 ? progress - 1 : progress
    }
}

private struct ParkingLegend: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            legendRow(color: .red, text: "Red means cannot park")
            legendRow(color: .yellow, text: "Yellow means paid parking")
            legendRow(color: .green, text: "Green means likely free · verify signs")
            legendRow(color: .gray, text: "Gray means unknown — check signs")
            Text("Classifications cover the selected arrival-to-leave interval.")
                .foregroundStyle(.secondary)
                .padding(.top, 2)
        }
        .font(.caption2)
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(AppTheme.cloud.opacity(0.84))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(AppTheme.action.opacity(0.2), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func legendRow(color: Color, text: String) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(text)
                .foregroundStyle(.secondary)
        }
    }
}

private struct GarageLegend: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Garage mode")
                .font(.caption)
                .bold()
            Text("Use the list or tap pins to select a garage")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(AppTheme.cloud.opacity(0.84))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(AppTheme.action.opacity(0.2), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct GaragePopup: View {
    let garage: GarageOption
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(garage.name)
                    .font(.subheadline)
                    .bold()

                Spacer()

                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 30, height: 30)
                        .background(AppTheme.breeze.opacity(0.62), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close garage details")
            }
            Text(garage.address)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            Text("Distance: \(garage.distanceText)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let licenseNumber = garage.licenseNumber {
                Text("NYC DCWP license \(licenseNumber) · \(garage.licenseStatus ?? "status unavailable")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text("Directory listing only. Capacity, pricing, and space availability are not provided.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: 360, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(AppTheme.cloud.opacity(0.84))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(AppTheme.action.opacity(0.22), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(radius: 8)
    }
}

private struct ParkingPopup: View {
    let segment: CurbSegment
    let nextChange: Date?
    let countdownText: String?
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(segment.name)
                        .font(.subheadline)
                        .bold()

                    Text(segment.status.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .padding(8)
                        .foregroundStyle(AppTheme.ink)
                }
                .buttonStyle(.plain)
                .background(
                    Circle()
                        .fill(AppTheme.breeze.opacity(0.62))
                        .overlay(
                            Circle()
                                .stroke(AppTheme.action.opacity(0.24), lineWidth: 1)
                        )
                )
                .clipShape(Circle())
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Times")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if segment.status == .legalNow {
                    Text("Likely free · verify signs")
                        .font(.callout)
                } else if segment.status == .caution {
                    Text("Parking allowed now, but payment is required")
                        .font(.callout)
                } else if segment.status == .illegalNow {
                    Text("Do not park here right now")
                        .font(.callout)
                } else {
                    Text("Rules unclear • Confirm posted signs")
                        .font(.callout)
                }

                if let countdownText, let nextChange {
                    Text("Status changes in \(countdownText) (\(nextChange.shortTime()))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let nextChange {
                    Text("Next expected change: \(nextChange.shortTime())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("No upcoming change time available from current data.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Fees")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if segment.isMeteredLikely {
                    Text("Paid hours: \(segment.paidHoursText ?? "check meter or ParkNYC")")
                        .font(.callout)
                    Text("Rate: \(segment.rateText ?? "check meter or ParkNYC")")
                        .font(.callout)
                } else {
                    Text("No meter flag • Still confirm signage")
                        .font(.callout)
                }
            }

            Text(segment.explanation)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Text("Always obey posted signs.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: 360, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(AppTheme.cloud.opacity(0.86))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(AppTheme.action.opacity(0.24), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(radius: 8)
    }
}

private struct HydrantPoint: Identifiable {
    let id: String
    let coordinate: CLLocationCoordinate2D
}

private struct HydrantNoParkingSegment: Identifiable {
    let id: String
    let coordinates: [CLLocationCoordinate2D]
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}

private extension MKCoordinateRegion {
    func contains(_ coordinate: CLLocationCoordinate2D) -> Bool {
        let minLat = center.latitude - (span.latitudeDelta / 2)
        let maxLat = center.latitude + (span.latitudeDelta / 2)
        let minLng = center.longitude - (span.longitudeDelta / 2)
        let maxLng = center.longitude + (span.longitudeDelta / 2)
        return coordinate.latitude >= minLat &&
            coordinate.latitude <= maxLat &&
            coordinate.longitude >= minLng &&
            coordinate.longitude <= maxLng
    }
}

private extension Color {
    init(hex: String) {
        let raw = hex.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        var value: UInt64 = 0
        Scanner(string: raw).scanHexInt64(&value)

        let r, g, b: Double
        if raw.count == 6 {
            r = Double((value >> 16) & 0xFF) / 255.0
            g = Double((value >> 8) & 0xFF) / 255.0
            b = Double(value & 0xFF) / 255.0
        } else {
            r = 0.73
            g = 0.76
            b = 0.86
        }

        self.init(red: r, green: g, blue: b)
    }
}
