import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var showLicense = false

    var body: some View {
        @Bindable var model = model
        Form {
            Section("Fahrrad") {
                LabeledContent(
                    "Durchschnittstempo",
                    value: "\(Int(model.settings.cyclingSpeedKilometersPerHour.rounded())) km/h"
                )
                Slider(
                    value: $model.settings.cyclingSpeedKilometersPerHour,
                    in: NavigationSettings.cyclingSpeedRange,
                    step: 1
                ) {
                    Text("Durchschnittstempo")
                } minimumValueLabel: {
                    Text("10")
                } maximumValueLabel: {
                    Text("30")
                }
                .accessibilityValue("\(Int(model.settings.cyclingSpeedKilometersPerHour.rounded())) Kilometer pro Stunde")

                Text("FoldRoute nutzt das Tempo für Fahrradzeiten und die Auswahl passender ÖPNV-Verbindungen.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Radetappen") {
                Stepper(value: $model.settings.maxCyclingMinutes, in: 1...60) {
                    LabeledContent("Maximale Radzeit je Etappe", value: "\(model.settings.maxCyclingMinutes) Min.")
                }
                Text("Gilt für jede Radetappe deiner ÖPNV-Reise. Falten, Entfalten und Anschlusspuffer kommen hinzu. Geplante Routen werden beim Verlassen der Einstellungen neu berechnet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Fußwege") {
                Stepper(value: $model.settings.maxWalkingMinutes, in: 1...15) {
                    LabeledContent("Maximale Gehzeit je Zubringer", value: "\(model.settings.maxWalkingMinutes) Min.")
                }
                Text("Gilt jeweils zum ersten Einstieg und vom letzten Ausstieg. Faltzeiten und Fußwege beim Umsteigen zählen nicht dazu. Geplante Routen werden beim Verlassen der Einstellungen neu berechnet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Rad-Umstiege") {
                Stepper(value: $model.settings.maxBikeTransfers, in: 0...3) {
                    LabeledContent("Maximale Anzahl", value: model.settings.maxBikeTransfers == 0 ? "Aus" : "\(model.settings.maxBikeTransfers)")
                }
                Text("Radstrecken zwischen ÖPNV-Fahrten. Falten, Entfalten und Anschlusspuffer kommen zur Fahrzeit hinzu. Erste und letzte Radetappe zählen nicht mit. Geplante Routen werden beim Verlassen der Einstellungen neu berechnet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Klapprad") {
                Stepper(value: $model.settings.foldingDuration, in: NavigationSettings.foldingDurationRange, step: 30) {
                    LabeledContent("Falten / Entfalten", value: model.settings.foldingDurationLabel)
                }
                Text("Gilt jeweils fürs Falten und Entfalten. FoldRoute berücksichtigt die Zeit bei der Routenplanung.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                ForEach(TransitModePreference.allCases) { mode in
                    Toggle(mode.title, isOn: transitModeBinding(for: mode))
                }
            } header: {
                Text("Verkehrsmittel")
            } footer: {
                Text(transitModeFooter)
            }

            Section("Hinweise") {
                Toggle("Sprachansagen", isOn: $model.settings.audioEnabled)
                Toggle("Haptische Hinweise", isOn: $model.settings.hapticsEnabled)
            }

            Section("Standort") {
                LabeledContent("Berechtigung", value: authorizationText)
                if model.location.isAuthorized, !model.location.hasPreciseLocation {
                    Label("Genaue Ortung ist ausgeschaltet. Abbiegehinweise können unpräzise sein.", systemImage: "location.slash")
                        .font(.footnote)
                        .foregroundStyle(FoldRouteColor.alertCoral)
                }
                Button("Standort erneut anfragen") { model.requestLocation() }
            }

            Section("Lizenzen & Datenquellen") {
                Button("FoldRoute · MIT-Lizenz") { showLicense = true }
                Link("Transitous und Fahrplandaten", destination: URL(string: "https://transitous.org/sources/")!)
                Link("© OpenStreetMap-Mitwirkende", destination: URL(string: "https://www.openstreetmap.org/copyright")!)
                Text("Beim Planen werden Start, Ziel und Zeitpunkt an Transitous übertragen. GPS-Verläufe speichert FoldRoute nicht.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button("Einstellungen speichern") { model.saveSettings() }
                Button("Alle lokalen Daten löschen", role: .destructive) { confirmDelete = true }
            }

            if let message = model.dataMessage {
                Section {
                    Text(message)
                        .font(.footnote)
                        .accessibilityLabel("Status: \(message)")
                }
            }

            Section("Über FoldRoute") {
                LabeledContent("Version", value: version)
            }
        }
        .navigationTitle("Einstellungen")
        .sheet(isPresented: $showLicense) {
            FoldRouteLicenseView()
        }
        .onDisappear { model.finishSettingsEditing() }
        .confirmationDialog("Lokale Daten löschen?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Alles löschen", role: .destructive) { model.clearLocalData() }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Favoriten, letzte Ziele, Einstellungen und Fahrten werden unwiderruflich entfernt.")
        }
    }

    private var authorizationText: String {
        switch model.location.authorizationStatus {
        case .authorizedAlways: "Immer"
        case .authorizedWhenInUse: "Beim Verwenden"
        case .denied: "Abgelehnt"
        case .restricted: "Eingeschränkt"
        case .notDetermined: "Noch nicht gefragt"
        @unknown default: "Unbekannt"
        }
    }

    private func transitModeBinding(for mode: TransitModePreference) -> Binding<Bool> {
        Binding(
            get: { model.settings.isTransitModeEnabled(mode) },
            set: { model.settings.setTransitMode(mode, enabled: $0) }
        )
    }

    private var transitModeFooter: String {
        model.settings.allowedTransitModes.isEmpty
            ? "Ohne Verkehrsmittel plant FoldRoute ausschließlich Fahrradrouten."
            : "Ausgeschaltete Verkehrsmittel werden bei neuen Routen nicht verwendet."
    }

    private var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(short) (\(build))"
    }
}

private struct FoldRouteLicenseView: View {
    @Environment(\.dismiss) private var dismiss

    private static let license: String = {
        guard let url = Bundle.main.url(forResource: "FoldRoute-LICENSE", withExtension: "txt") else {
            preconditionFailure("FoldRoute-LICENSE.txt must be included in the app bundle")
        }
        return try! String(contentsOf: url, encoding: .utf8)
    }()

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(verbatim: Self.license)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle("MIT-Lizenz")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }
}
