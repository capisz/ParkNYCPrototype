import SwiftUI
import MapKit
import Combine
import CoreLocation

private enum AppStage {
    case landing
    case results
}

private enum ParkingMode: String, CaseIterable, Identifiable {
    case street = "Street"
    case garages = "Garages"

    var id: String { rawValue }
}

private enum AuthFormMode: String, CaseIterable, Identifiable {
    case login = "Log In"
    case signUp = "Sign Up"

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

struct ContentView: View {
    @StateObject private var locationManager = LocationManager()
    @StateObject private var curbVM = CurbViewModel()
    @StateObject private var authSession = AuthSessionManager()
    @StateObject private var locationSuggestions = LocationSuggestionsStore()

    private let garageService = GarageSearchService()
    private let hydrantService = NYCHydrantService()
    private let liveRefreshTimer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    private let countdownTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    @State private var appStage: AppStage = .landing
    @State private var mode: ParkingMode = .street
    @State private var showOptionsList = true

    @State private var searchText: String = ""
    @State private var searchStatus: String? = nil
    @State private var isSearchingDestination = false
    @State private var pendingSuggestion: MKLocalSearchCompletion?

    @State private var destinationName: String = ""
    @State private var destinationCoordinate: CLLocationCoordinate2D?
    @State private var mapCenterCoordinate: CLLocationCoordinate2D?
    @State private var mapVisibleRegion: MKCoordinateRegion?
    @State private var countdownNow: Date = Date()
    @State private var derivedNextChangeBySegmentID: [UUID: Date] = [:]

    @State private var position: MapCameraPosition = .automatic

    @State private var selectedStreet: CurbSegment?

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

    @State private var authMode: AuthFormMode = .login
    @State private var authName: String = ""
    @State private var authEmail: String = ""
    @State private var authPassword: String = ""
    @State private var authStatus: String? = nil

    @State private var authCardVisible = false
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

    private var navTitle: String { "Pidge" }

    var body: some View {
        NavigationStack {
            ZStack {
                if !authSession.isAuthenticated {
                    authGateView
                        .transition(.opacity)
                } else if appStage == .landing {
                    landingView
                        .transition(.opacity)
                } else {
                    resultsView
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.28), value: authSession.isAuthenticated)
            .animation(.easeInOut(duration: 0.28), value: appStage)
            .tint(AppTheme.action)
            .navigationTitle(navTitle)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .onAppear {
                locationManager.start()
            }
            .onReceive(liveRefreshTimer) { _ in
                guard authSession.isAuthenticated,
                      appStage == .results,
                      mode == .street else { return }
                if let mapVisibleRegion {
                    curbVM.refresh(in: mapVisibleRegion, force: true)
                } else if let refreshCoordinate = mapCenterCoordinate ?? destinationCoordinate {
                    curbVM.refresh(near: refreshCoordinate, force: true)
                }
            }
            .onReceive(countdownTimer) { _ in
                guard authSession.isAuthenticated,
                      appStage == .results,
                      mode == .street else { return }
                countdownNow = Date()
            }
            .onReceive(curbVM.$segments) { segments in
                recalculateDerivedNextChanges(for: segments, reference: Date())
                recalculateHydrantNoParkingSegments(segments: segments)
            }
        }
    }

    private var authGateView: some View {
        ZStack {
            LinearGradient(
                colors: [AppTheme.breeze, AppTheme.cloud, AppTheme.haze],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(AppTheme.breeze.opacity(0.45))
                .frame(width: 380, height: 380)
                .blur(radius: 18)
                .offset(x: 140, y: -210)

            Circle()
                .fill(AppTheme.haze.opacity(0.35))
                .frame(width: 320, height: 320)
                .blur(radius: 26)
                .offset(x: -150, y: 260)

            VStack(alignment: .leading, spacing: 18) {
                Spacer(minLength: 8)

                Text("Welcome to Pidge")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(AppTheme.ink)

                Text("Log in or sign up to keep your parking settings synced.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.ink.opacity(0.82))

                if let backendNote = authSession.backendNote {
                    Text(backendNote)
                        .font(.caption)
                        .foregroundStyle(AppTheme.ink.opacity(0.76))
                } else {
                    Text("Using \(authSession.backendLabel) authentication.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.ink.opacity(0.76))
                }

                Picker("Account", selection: $authMode) {
                    ForEach(AuthFormMode.allCases) { currentMode in
                        Text(currentMode.rawValue).tag(currentMode)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: authMode) { _, _ in
                    authStatus = nil
                }

                if authMode == .signUp {
                    TextField("Name", text: $authName)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(AppTheme.softSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                TextField("Email", text: $authEmail)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 11)
                    .background(AppTheme.softSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
#if os(iOS)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
#endif

                SecureField("Password", text: $authPassword)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 11)
                    .background(AppTheme.softSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                Button(authMode == .login ? "Log In" : "Create Account") {
                    Task {
                        await submitAuth()
                    }
                }
                .buttonStyle(.borderedProminent)

                Button("Continue as Guest") {
                    authSession.continueAsGuest()
                }
                .buttonStyle(.bordered)

                if let authStatus {
                    Text(authStatus)
                        .font(.caption)
                        .foregroundStyle(AppTheme.ink.opacity(0.82))
                }

                Spacer(minLength: 8)
            }
            .padding(24)
            .opacity(authCardVisible ? 1 : 0)
            .offset(y: authCardVisible ? 0 : 14)
            .onAppear {
                authCardVisible = false
                withAnimation(.easeOut(duration: 0.45)) {
                    authCardVisible = true
                }
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

                    HStack {
                        Spacer()
                        Button("Log Out") {
                            authSession.logOut()
                            resetForLoggedOutState()
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .fill(AppTheme.action.opacity(0.9))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                                        .stroke(AppTheme.ink.opacity(0.18), lineWidth: 1)
                                )
                        )
                        .buttonStyle(.plain)
                        Spacer()
                    }
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

    private var resultsView: some View {
        ZStack(alignment: .bottom) {
            resultsMap
            resultsBottomPanel
        }
    }

    private var resultsMap: some View {
        MapReader { proxy in
            ZStack(alignment: .topTrailing) {
                Map(position: $position) {
                    if let destinationCoordinate {
                        Marker("Destination", systemImage: "mappin.and.ellipse", coordinate: destinationCoordinate)
                            .tint(.orange)
                    }

                    if mode == .street {
                        streetMapLayer
                        hydrantMapLayer
                    } else {
                        garageMapLayer
                    }
                }
                .onMapCameraChange(frequency: .onEnd) { context in
                    guard authSession.isAuthenticated,
                          appStage == .results else { return }
                    let center = context.region.center
                    guard CLLocationCoordinate2DIsValid(center) else { return }

                    mapCenterCoordinate = center
                    mapVisibleRegion = context.region
                    if mode == .street {
                        initializeHydrantVisibilityThresholdIfNeeded(for: context.region)
                        curbVM.refresh(in: context.region)
                        refreshHydrants(for: context.region)
                    }
                }
                .simultaneousGesture(
                    SpatialTapGesture().onEnded { value in
                        guard mode == .street else { return }
                        guard let coordinate = proxy.convert(value.location, from: .local) else { return }
                        handleStreetTap(at: coordinate)
                    }
                )
                .mapStyle(.standard(elevation: .realistic))
                .mapControls {
                    MapUserLocationButton()
                    MapCompass()
                    MapScaleView()
                }
                .ignoresSafeArea()

                VStack(alignment: .trailing, spacing: 10) {
                    zoomControls

                    if mode == .street, let segment = selectedStreet {
                        ParkingPopup(
                            segment: segment,
                            nextChange: nextChangeDate(for: segment, reference: countdownNow),
                            countdownText: countdownText(for: segment, now: countdownNow)
                        ) {
                            selectedStreet = nil
                        }
                    } else if mode == .garages, let garage = selectedGarage {
                        GaragePopup(garage: garage)
                    }
                }
                .padding(.top, 10)
                .padding(.trailing, 10)
                .contentShape(Rectangle())
                .onTapGesture {}
            }
        }
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

    private var resultsBottomPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Button {
                        focusOnDestination()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "scope")
                                .font(.caption)
                            Text(destinationName.isEmpty ? "Selected destination" : destinationName)
                                .font(.headline)
                                .lineLimit(1)
                        }
                        .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Center map on destination")
                }
                Spacer()
                Button(showOptionsList ? "Hide List" : "Show List") {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showOptionsList.toggle()
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(AppTheme.ink.opacity(0.9))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(AppTheme.action.opacity(0.4), lineWidth: 1)
                        )
                )
                .buttonStyle(.plain)

                Button {
                    resetToLanding()
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(AppTheme.ink.opacity(0.95))
                        .padding(9)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(AppTheme.cloud.opacity(0.95))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(AppTheme.action.opacity(0.3), lineWidth: 1)
                                )
                        )
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

            if showOptionsList {
                if mode == .street {
                    streetOptionsPanel
                        .opacity(1)
                        .transition(.opacity)
                } else {
                    garageOptionsPanel
                        .opacity(1)
                        .transition(.opacity)
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(showOptionsList ? AppTheme.cloud.opacity(0.98) : AppTheme.cloud.opacity(0.82))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(AppTheme.action.opacity(0.22), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding()
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
                Text("Nearby garage options")
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
                Text(isLoadingGarages ? "Loading garages…" : "No garage options found yet.")
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

    private func submitAuth() async {
        let result: Result<Void, AuthError>
        switch authMode {
        case .login:
            result = await authSession.logIn(email: authEmail, password: authPassword)
        case .signUp:
            result = await authSession.signUp(name: authName, email: authEmail, password: authPassword)
        }

        switch result {
        case .success:
            authStatus = nil
            authPassword = ""
            authName = ""
            withAnimation(.easeInOut(duration: 0.2)) {
                appStage = .landing
            }
        case .failure(let error):
            authStatus = error.localizedDescription
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

        let bounded = placemarks.filter { placemark in
            guard let coordinate = placemark.location?.coordinate else { return false }
            return region.contains(coordinate)
        }

        let chosen = bounded.first ?? placemarks.first
        guard let coordinate = chosen?.location?.coordinate,
              CLLocationCoordinate2DIsValid(coordinate) else {
            return nil
        }

        let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
        item.name = chosen?.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? query
        return item
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
        mode = .street
        showOptionsList = true
        appStage = .results

        selectedStreet = nil
        selectedGarage = nil
        garages = []
        garageStatus = "Loading garage options…"

        let destinationRegion = MKCoordinateRegion(
            center: coordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
        )
        mapVisibleRegion = destinationRegion
        position = .region(destinationRegion)

        initializeHydrantVisibilityThresholdIfNeeded(for: destinationRegion, reset: true)
        curbVM.refresh(in: destinationRegion, force: true)
        refreshHydrants(for: destinationRegion, force: true)
        loadGarages(near: coordinate)
    }

    private func loadGarages(near coordinate: CLLocationCoordinate2D) {
        isLoadingGarages = true
        garageStatus = "Loading garage options…"

        Task {
            do {
                let result = try await garageService.fetchGarages(near: coordinate)
                await MainActor.run {
                    guard isSameCoordinate(lhs: destinationCoordinate, rhs: coordinate) else { return }

                    garages = result
                    isLoadingGarages = false
                    garageStatus = result.isEmpty ? "No garages found near this destination." : nil
                }
            } catch {
                await MainActor.run {
                    guard isSameCoordinate(lhs: destinationCoordinate, rhs: coordinate) else { return }

                    garages = []
                    isLoadingGarages = false
                    garageStatus = "Garage lookup failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func refreshHydrants(for region: MKCoordinateRegion, force: Bool = false) {
        guard mode == .street else {
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
                let fetched = try await hydrantService.fetchHydrants(
                    near: center,
                    radiusMeters: radiusMeters,
                    limit: 350
                )
                await MainActor.run {
                    guard !Task.isCancelled else { return }
                    hydrants = fetched
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

    private func recalculateHydrantNoParkingSegments(segments: [CurbSegment]? = nil) {
        guard mode == .street else {
            hydrantNoParkingSegments = []
            return
        }

        let sourceSegments = segments ?? curbVM.segments
        guard !sourceSegments.isEmpty, !hydrants.isEmpty else {
            hydrantNoParkingSegments = []
            return
        }

        var blocked: [HydrantNoParkingSegment] = []
        blocked.reserveCapacity(hydrants.count)

        for hydrant in hydrants {
            guard let snapped = snapHydrantToNearestSegment(
                hydrant.coordinate,
                segments: sourceSegments,
                maxDistanceMeters: hydrantSegmentSnapMaxDistanceMeters
            ) else {
                continue
            }

            let clipped = clippedCoordinates(
                along: snapped.segment.coordinates,
                fromDistanceMeters: snapped.distanceAlongMeters - hydrantNoParkingEachSideMeters,
                toDistanceMeters: snapped.distanceAlongMeters + hydrantNoParkingEachSideMeters
            )
            guard clipped.count >= 2 else { continue }

            blocked.append(
                HydrantNoParkingSegment(
                    id: "\(snapped.segment.id.uuidString)-\(hydrant.id)",
                    coordinates: clipped
                )
            )
        }

        hydrantNoParkingSegments = blocked
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

        if newMode == .street {
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

    private func recalculateDerivedNextChanges(for segments: [CurbSegment], reference: Date) {
        var nextByID: [UUID: Date] = [:]
        for segment in segments {
            if let explicit = segment.nextChange, explicit > reference {
                nextByID[segment.id] = explicit
                continue
            }

            if let derived = PaidHoursTransitionEstimator.nextTransition(after: reference, rawText: segment.paidHoursText) {
                nextByID[segment.id] = derived
            }
        }
        derivedNextChangeBySegmentID = nextByID
    }

    private func nextChangeDate(for segment: CurbSegment, reference: Date) -> Date? {
        if let explicit = segment.nextChange, explicit > reference {
            return explicit
        }
        if let derived = derivedNextChangeBySegmentID[segment.id], derived > reference {
            return derived
        }
        return PaidHoursTransitionEstimator.nextTransition(after: reference, rawText: segment.paidHoursText)
    }

    private func countdownText(for segment: CurbSegment, now: Date) -> String? {
        guard let nextChange = nextChangeDate(for: segment, reference: now) else { return nil }
        let remaining = Int(nextChange.timeIntervalSince(now))
        guard remaining > 0, remaining <= 3600 else { return nil }

        let minutes = remaining / 60
        let seconds = remaining % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    private func focusOnDestination() {
        guard let destinationCoordinate else { return }
        mapCenterCoordinate = destinationCoordinate
        let region = MKCoordinateRegion(
            center: destinationCoordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
        )
        mapVisibleRegion = region
        position = .region(region)
    }

    private func zoomMap(factor: Double) {
        guard factor > 0 else { return }

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

        if mode == .street {
            curbVM.refresh(in: nextRegion)
            refreshHydrants(for: nextRegion)
        }
    }

    private func handleStreetTap(at coordinate: CLLocationCoordinate2D) {
        guard let tappedSegment = nearestStreetSegment(to: coordinate, maxDistanceMeters: 38) else { return }
        selectStreet(tappedSegment)
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

        position = .region(
            MKCoordinateRegion(
                center: garage.coordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
            )
        )
    }

    private func resetToLanding() {
        appStage = .landing
        mode = .street
        showOptionsList = true

        selectedStreet = nil
        selectedGarage = nil
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

    private func resetForLoggedOutState() {
        appStage = .landing
        mode = .street
        showOptionsList = true

        searchText = ""
        searchStatus = nil
        locationSuggestions.clear()

        destinationName = ""
        destinationCoordinate = nil
        mapCenterCoordinate = nil
        mapVisibleRegion = nil
        pendingSuggestion = nil
        clearHydrants()
        hydrantVisibilityShortEdgeThresholdMeters = nil

        selectedStreet = nil
        selectedGarage = nil
        garages = []
        garageStatus = nil

        authMode = .login
        authName = ""
        authEmail = ""
        authPassword = ""
        authStatus = nil

        position = .automatic
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
            Text("Pidge")
                .font(.system(size: 32, weight: .heavy, design: .rounded))
                .tracking(0.9)
                .foregroundStyle(AppTheme.ink)
                .opacity(0.8)

            Image("PigeonLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 116, height: 116)
                .opacity(0.7)
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
            legendRow(color: .red, text: "Red: do not park")
            legendRow(color: .yellow, text: "Yellow: paid parking")
            legendRow(color: .green, text: "Green: free parking")
            Text("Live update: every 60s")
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(garage.name)
                .font(.subheadline)
                .bold()
            Text(garage.address)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            Text("Distance: \(garage.distanceText)")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(width: 280)
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
                    Text("Free parking right now")
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
                    Text("Paid hours: \(segment.paidHoursText ?? "check meter/Pidge")")
                        .font(.callout)
                    Text("Rate: \(segment.rateText ?? "check meter/Pidge")")
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
        .frame(width: 300)
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

private final class NYCHydrantService {
    private let endpoint = URL(string: "https://data.cityofnewyork.us/resource/5bgh-vtsn.json")!
    private let session: URLSession
    private let appToken: String?

    init(
        session: URLSession = .shared,
        appToken: String? = Bundle.main.object(forInfoDictionaryKey: "NYCOpenDataAppToken") as? String
    ) {
        self.session = session
        self.appToken = appToken?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    func fetchHydrants(
        near coordinate: CLLocationCoordinate2D,
        radiusMeters: Int,
        limit: Int
    ) async throws -> [HydrantPoint] {
        guard CLLocationCoordinate2DIsValid(coordinate) else { return [] }

        let clampedRadius = max(80, min(700, radiusMeters))
        let clampedLimit = max(1, min(600, limit))
        let whereClause = "within_circle(the_geom,\(coordinate.latitude),\(coordinate.longitude),\(clampedRadius))"
        let selectClause = "unitid,boro,the_geom,latitude,longitude"

        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "$select", value: selectClause),
            URLQueryItem(name: "$where", value: whereClause),
            URLQueryItem(name: "$limit", value: String(clampedLimit))
        ]

        guard let url = components?.url else {
            return []
        }

        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = appToken {
            request.setValue(token, forHTTPHeaderField: "X-App-Token")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            return []
        }

        let rows = try JSONDecoder().decode([HydrantRow].self, from: data)
        let center = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        var seen = Set<String>()
        let mapped = rows.compactMap { row -> (HydrantPoint, CLLocationDistance)? in
            guard let pointCoordinate = row.coordinate,
                  CLLocationCoordinate2DIsValid(pointCoordinate) else {
                return nil
            }

            let identifier = row.unitID?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ??
                String(format: "%.6f,%.6f", pointCoordinate.latitude, pointCoordinate.longitude)
            guard seen.insert(identifier).inserted else { return nil }

            let distance = center.distance(
                from: CLLocation(latitude: pointCoordinate.latitude, longitude: pointCoordinate.longitude)
            )
            return (HydrantPoint(id: identifier, coordinate: pointCoordinate), distance)
        }
        .sorted { lhs, rhs in
            lhs.1 < rhs.1
        }

        return mapped.map(\.0)
    }
}

private struct HydrantRow: Decodable {
    let unitID: String?
    let latitude: String?
    let longitude: String?
    let geometry: HydrantGeometry?

    enum CodingKeys: String, CodingKey {
        case unitID = "unitid"
        case latitude
        case longitude
        case geometry = "the_geom"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        unitID = try container.decodeIfPresent(String.self, forKey: .unitID)
        geometry = try container.decodeIfPresent(HydrantGeometry.self, forKey: .geometry)
        latitude = Self.decodeString(from: container, forKey: .latitude)
        longitude = Self.decodeString(from: container, forKey: .longitude)
    }

    var coordinate: CLLocationCoordinate2D? {
        if let geometry,
           let coordinate = geometry.coordinate,
           CLLocationCoordinate2DIsValid(coordinate) {
            return coordinate
        }

        guard let latitudeValue = Double(latitude ?? ""),
              let longitudeValue = Double(longitude ?? "") else {
            return nil
        }

        let fallback = CLLocationCoordinate2D(latitude: latitudeValue, longitude: longitudeValue)
        return CLLocationCoordinate2DIsValid(fallback) ? fallback : nil
    }

    private static func decodeString(
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> String? {
        if let value = try? container.decodeIfPresent(String.self, forKey: key) {
            return value
        }
        if let value = try? container.decodeIfPresent(Double.self, forKey: key) {
            return String(value)
        }
        if let value = try? container.decodeIfPresent(Int.self, forKey: key) {
            return String(value)
        }
        return nil
    }
}

private struct HydrantGeometry: Decodable {
    let type: String
    let coordinates: [Double]

    var coordinate: CLLocationCoordinate2D? {
        guard type == "Point", coordinates.count >= 2 else { return nil }
        return CLLocationCoordinate2D(latitude: coordinates[1], longitude: coordinates[0])
    }
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
