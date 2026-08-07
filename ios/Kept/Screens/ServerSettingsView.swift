import SwiftUI

// Development only. The whole screen is compiled out of a shipped
// build: in production the server address is not configuration
// (see ServerEnvironment), so a screen for editing it would be a
// control with nothing legitimate to do and one dangerous thing it
// could do - point an installed app at another server.
#if DEBUG

/// Which server the app talks to - the affordance that lets a device on
/// the same network reach a backend running on the development Mac. Not a
/// user-facing feature; a development necessity kept deliberately small.
struct ServerSettingsView: View {
    @EnvironmentObject private var serverConfig: ServerConfig
    @Environment(\.dismiss) private var dismiss

    @State private var input = ""
    @State private var validationMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://localhost:3000", text: $input)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("API server")
                } footer: {
                    Text("""
                    The simulator reaches a server on this Mac at \
                    http://localhost:3000. A device uses the Mac's local \
                    name instead, like http://your-mac.local:3000.
                    """)
                }

                if let validationMessage {
                    Section {
                        Text(validationMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if let note = serverConfig.discardedOverrideNote {
                    Section {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if serverConfig.isOverridden {
                    Section {
                        Button("Reset to default") {
                            serverConfig.resetToDefault()
                            input = serverConfig.baseURL.absoluteString
                            validationMessage = nil
                        }
                    }
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                }
            }
            .onAppear {
                input = serverConfig.baseURL.absoluteString
            }
        }
    }

    private func save() {
        do {
            try serverConfig.setOverride(input)
            dismiss()
        } catch {
            validationMessage = error.localizedDescription
        }
    }
}
#endif
