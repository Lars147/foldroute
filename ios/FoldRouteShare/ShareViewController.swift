import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
@Observable
final class ShareDraft {
    var text = ""
    var loading = true
    var message: String?
}

@MainActor
final class ShareViewController: UIViewController {
    private let draft = ShareDraft()
    private var loadingTask: Task<Void, Never>?

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareDestinationDraft(draft: draft, save: { [weak self] in
            self?.save()
        }, cancel: { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
        loadingTask = Task { await loadSharedContent() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        loadingTask?.cancel()
    }

    private func loadSharedContent() async {
        var values: [String] = []
        defer { draft.loading = false; draft.text = values.joined(separator: "\n") }
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return }
        do {
            for item in items {
                if let content = item.attributedContentText?.string, !content.isEmpty { values.append(content) }
                for provider in item.attachments ?? [] {
                    for type in [UTType.url.identifier, UTType.plainText.identifier] where provider.hasItemConformingToTypeIdentifier(type) {
                        let value = try await Self.load(provider, type: type)
                        try Task.checkCancellation()
                        if !value.isEmpty && !values.contains(value) { values.append(value) }
                    }
                }
            }
            draft.text = values.joined(separator: "\n")
            if draft.text.isEmpty { draft.message = "Keine Adresse erhalten. Bitte Ziel eingeben." }
        } catch is CancellationError {
        } catch {
            draft.message = "Inhalt konnte nicht geladen werden. Bitte Ziel eingeben."
        }
    }

    private static func load(_ provider: NSItemProvider, type: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else if let url = item as? URL { continuation.resume(returning: url.absoluteString) }
                else if let text = item as? String { continuation.resume(returning: text) }
                else { continuation.resume(throwing: SharedDestinationStorageError.invalid) }
            }
        }
    }

    private func save() {
        let payload = SharePayload(text: draft.text)
        guard SharedDestination.parse(payload).kind != "invalid" else {
            draft.message = "Bitte eine gültige Adresse oder einen Kartenlink eingeben."
            return
        }
        do {
            try SharedDestinationStore.configured().save(PendingSharedDestination(payload: payload))
            extensionContext?.completeRequest(returningItems: nil)
        } catch {
            draft.message = error.localizedDescription
        }
    }
}

private struct ShareDestinationDraft: View {
    @Bindable var draft: ShareDraft
    let save: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Ziel") {
                    if draft.loading { ProgressView("Adresse wird geladen …") }
                    TextEditor(text: $draft.text)
                        .frame(minHeight: 100)
                        .accessibilityLabel("Geteilte Adresse oder Kartenlink")
                        .disabled(draft.loading)
                    Text("Wird beim nächsten Öffnen von FoldRoute übernommen. Ein zuvor vorgemerktes Ziel wird ersetzt.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let message = draft.message { Section { Text(message).accessibilityLabel("Fehler: \(message)") } }
            }
            .navigationTitle("FoldRoute")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen", action: cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ziel vormerken", action: save)
                        .disabled(draft.loading || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
