import AVFoundation
import UIKit
import UserNotifications

@MainActor
final class GuidanceService {
    private let synthesizer = AVSpeechSynthesizer()
    private let notificationCenter: UNUserNotificationCenter
    private var alertGeneration = UUID()

    init(notificationCenter: UNUserNotificationCenter = .current()) {
        self.notificationCenter = notificationCenter
    }

    func requestNotificationAuthorization() async {
        _ = try? await notificationCenter.requestAuthorization(options: [.alert, .sound])
    }

    func speak(_ text: String, settings: NavigationSettings) {
        guard settings.audioEnabled else { return }
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .word) }
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        try? audioSession.setActive(true)

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "de-DE")
        utterance.rate = 0.48
        synthesizer.speak(utterance)
    }

    func signal(_ type: UINotificationFeedbackGenerator.FeedbackType, settings: NavigationSettings) {
        guard settings.hapticsEnabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }

    func scheduleTransitAlerts(for journey: Journey, startingAt legIndex: Int = 0, settings: NavigationSettings = .defaults) async {
        cancelAlerts()
        let generation = alertGeneration
        for reminder in TransitReminder.remaining(in: journey, from: legIndex, now: Date()) {
            guard !Task.isCancelled, generation == alertGeneration else { return }
            let id = "foldroute-\(generation)-\(reminder.id)"
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            if settings.audioEnabled { content.sound = .default }
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, reminder.date.timeIntervalSinceNow), repeats: false)
            try? await notificationCenter.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
            if Task.isCancelled || generation != alertGeneration {
                notificationCenter.removePendingNotificationRequests(withIdentifiers: [id])
                return
            }
        }
    }

    func cancelAlerts() {
        alertGeneration = UUID()
        notificationCenter.removeAllPendingNotificationRequests()
    }
}
