import Foundation
import Combine
import Security

#if canImport(FirebaseCore)
import FirebaseCore
#endif

#if canImport(FirebaseAuth)
import FirebaseAuth
#endif

struct AuthUser: Codable, Equatable {
    let name: String
    let email: String
}

enum AuthBackend {
    case firebase
    case localFallback
}

enum AuthError: LocalizedError {
    case invalidName
    case invalidEmail
    case weakPassword
    case accountExists
    case accountNotFound
    case wrongPassword
    case storageFailure
    case unknownAuthError(String?)

    var errorDescription: String? {
        switch self {
        case .invalidName:
            return "Please enter your name."
        case .invalidEmail:
            return "Please enter a valid email address."
        case .weakPassword:
            return "Password must be at least 6 characters."
        case .accountExists:
            return "An account with that email already exists."
        case .accountNotFound:
            return "No account found for that email."
        case .wrongPassword:
            return "Incorrect password."
        case .storageFailure:
            return "Could not save account data."
        case .unknownAuthError(let message):
            return message ?? "Authentication failed."
        }
    }
}

@MainActor
final class AuthSessionManager: ObservableObject {
    @Published private(set) var currentUser: AuthUser?
    @Published private(set) var backend: AuthBackend = .localFallback
    @Published private(set) var isGuest = false

    var isAuthenticated: Bool {
        currentUser != nil
    }

    var backendLabel: String {
        switch backend {
        case .firebase: return "Firebase"
        case .localFallback: return "Local"
        }
    }

    var backendNote: String? {
        switch backend {
        case .firebase:
            return nil
        case .localFallback:
            return "Firebase SDK/config not detected. Using local prototype auth."
        }
    }

    private struct StoredAccount: Codable {
        let name: String
        let email: String
    }

    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private let accountsKey = "pidge.accounts.v1"
    private let currentUserEmailKey = "pidge.currentUserEmail.v1"
    private let keychainService = "chriszcodes.Pidge.auth"

    private var accounts: [String: StoredAccount] = [:]

#if canImport(FirebaseAuth)
    private var authStateListener: AuthStateDidChangeListenerHandle?
#endif

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        if configureFirebaseIfPossible() {
            backend = .firebase
            startFirebaseAuthListenerIfNeeded()
            currentUser = currentFirebaseUserSnapshot()
        } else {
            backend = .localFallback
            loadLocalState()
        }
    }

    deinit {
#if canImport(FirebaseAuth)
        if let authStateListener {
            Auth.auth().removeStateDidChangeListener(authStateListener)
        }
#endif
    }

    func signUp(name: String, email: String, password: String) async -> Result<Void, AuthError> {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanEmail = canonicalEmail(email)

        guard !cleanName.isEmpty else {
            return .failure(.invalidName)
        }
        guard isValidEmail(cleanEmail) else {
            return .failure(.invalidEmail)
        }
        guard password.count >= 6 else {
            return .failure(.weakPassword)
        }

        switch backend {
        case .firebase:
            return await signUpWithFirebase(name: cleanName, email: cleanEmail, password: password)
        case .localFallback:
            return signUpLocal(name: cleanName, email: cleanEmail, password: password)
        }
    }

    func logIn(email: String, password: String) async -> Result<Void, AuthError> {
        let cleanEmail = canonicalEmail(email)

        guard isValidEmail(cleanEmail) else {
            return .failure(.invalidEmail)
        }

        switch backend {
        case .firebase:
            return await logInWithFirebase(email: cleanEmail, password: password)
        case .localFallback:
            return logInLocal(email: cleanEmail, password: password)
        }
    }

    func logOut() {
        isGuest = false
        switch backend {
        case .firebase:
#if canImport(FirebaseAuth)
            do {
                try Auth.auth().signOut()
            } catch {
                print("Firebase sign out failed:", error.localizedDescription)
            }
#endif
            currentUser = nil
        case .localFallback:
            defaults.removeObject(forKey: currentUserEmailKey)
            currentUser = nil
        }
    }

    func continueAsGuest() {
        isGuest = true
        currentUser = AuthUser(name: "Guest", email: "")
    }

    private func signUpLocal(name: String, email: String, password: String) -> Result<Void, AuthError> {
        guard accounts[email] == nil else {
            return .failure(.accountExists)
        }

        guard setPassword(password, for: email) else {
            return .failure(.storageFailure)
        }

        accounts[email] = StoredAccount(name: name, email: email)
        guard persistAccounts() else {
            return .failure(.storageFailure)
        }

        defaults.set(email, forKey: currentUserEmailKey)
        currentUser = AuthUser(name: name, email: email)
        return .success(())
    }

    private func logInLocal(email: String, password: String) -> Result<Void, AuthError> {
        guard let account = accounts[email] else {
            return .failure(.accountNotFound)
        }

        guard let savedPassword = getPassword(for: email) else {
            return .failure(.accountNotFound)
        }

        guard savedPassword == password else {
            return .failure(.wrongPassword)
        }

        defaults.set(email, forKey: currentUserEmailKey)
        currentUser = AuthUser(name: account.name, email: account.email)
        return .success(())
    }

    private func loadLocalState() {
        if let data = defaults.data(forKey: accountsKey),
           let decoded = try? decoder.decode([String: StoredAccount].self, from: data) {
            accounts = decoded
        }

        guard let email = defaults.string(forKey: currentUserEmailKey),
              let account = accounts[email] else {
            currentUser = nil
            return
        }

        currentUser = AuthUser(name: account.name, email: account.email)
    }

    private func persistAccounts() -> Bool {
        guard let data = try? encoder.encode(accounts) else {
            return false
        }
        defaults.set(data, forKey: accountsKey)
        return true
    }

    private func canonicalEmail(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func isValidEmail(_ email: String) -> Bool {
        guard !email.isEmpty else { return false }
        let pattern = #"^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$"#
        return email.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func keychainAccountKey(for email: String) -> String {
        "pidge.user.\(email)"
    }

    private func setPassword(_ password: String, for email: String) -> Bool {
        let accountKey = keychainAccountKey(for: email)
        let encoded = Data(password.utf8)

        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: accountKey
        ]

        SecItemDelete(baseQuery as CFDictionary)

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = encoded

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    private func getPassword(for email: String) -> String? {
        let accountKey = keychainAccountKey(for: email)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: accountKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let password = String(data: data, encoding: .utf8) else {
            return nil
        }

        return password
    }

    private func configureFirebaseIfPossible() -> Bool {
#if canImport(FirebaseCore) && canImport(FirebaseAuth)
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            return false
        }

        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }

        return true
#else
        return false
#endif
    }

    private func startFirebaseAuthListenerIfNeeded() {
#if canImport(FirebaseAuth)
        guard backend == .firebase else { return }

        authStateListener = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                guard let self else { return }
                self.currentUser = self.mapFirebaseUser(user)
            }
        }
#endif
    }

    private func currentFirebaseUserSnapshot() -> AuthUser? {
#if canImport(FirebaseAuth)
        return mapFirebaseUser(Auth.auth().currentUser)
#else
        return nil
#endif
    }

#if canImport(FirebaseAuth)
    private func mapFirebaseUser(_ user: FirebaseAuth.User?) -> AuthUser? {
        guard let user, let email = user.email else {
            return nil
        }

        let displayName = user.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let displayName, !displayName.isEmpty {
            return AuthUser(name: displayName, email: email)
        }

        let fallbackName = email.split(separator: "@").first.map(String.init) ?? "User"
        return AuthUser(name: fallbackName, email: email)
    }

    private func signUpWithFirebase(name: String, email: String, password: String) async -> Result<Void, AuthError> {
        do {
            let authResult = try await createFirebaseUser(email: email, password: password)
            let changeRequest = authResult.user.createProfileChangeRequest()
            changeRequest.displayName = name
            try await commitProfileChanges(changeRequest)

            currentUser = AuthUser(name: name, email: email)
            return .success(())
        } catch {
            return .failure(mapFirebaseError(error))
        }
    }

    private func logInWithFirebase(email: String, password: String) async -> Result<Void, AuthError> {
        do {
            let authResult = try await signInFirebase(email: email, password: password)
            currentUser = mapFirebaseUser(authResult.user)
            return .success(())
        } catch {
            return .failure(mapFirebaseError(error))
        }
    }

    private func createFirebaseUser(email: String, password: String) async throws -> AuthDataResult {
        try await withCheckedThrowingContinuation { continuation in
            Auth.auth().createUser(withEmail: email, password: password) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let result else {
                    continuation.resume(throwing: NSError(domain: "Auth", code: -1))
                    return
                }
                continuation.resume(returning: result)
            }
        }
    }

    private func signInFirebase(email: String, password: String) async throws -> AuthDataResult {
        try await withCheckedThrowingContinuation { continuation in
            Auth.auth().signIn(withEmail: email, password: password) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let result else {
                    continuation.resume(throwing: NSError(domain: "Auth", code: -1))
                    return
                }
                continuation.resume(returning: result)
            }
        }
    }

    private func commitProfileChanges(_ request: UserProfileChangeRequest) async throws {
        try await withCheckedThrowingContinuation { continuation in
            request.commitChanges { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume()
            }
        }
    }

    private func mapFirebaseError(_ error: Error) -> AuthError {
        let nsError = error as NSError
        let code = AuthErrorCode(rawValue: nsError.code)

        switch code {
        case .emailAlreadyInUse:
            return .accountExists
        case .userNotFound:
            return .accountNotFound
        case .wrongPassword, .invalidCredential:
            return .wrongPassword
        case .invalidEmail:
            return .invalidEmail
        case .weakPassword:
            return .weakPassword
        default:
            return .unknownAuthError(nsError.localizedDescription)
        }
    }
#else
    private func signUpWithFirebase(name: String, email: String, password: String) async -> Result<Void, AuthError> {
        signUpLocal(name: name, email: email, password: password)
    }

    private func logInWithFirebase(email: String, password: String) async -> Result<Void, AuthError> {
        logInLocal(email: email, password: password)
    }
#endif
}
