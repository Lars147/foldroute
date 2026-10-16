import SwiftUI
import UIKit

enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "foldroute.appearance"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "System"
        case .light: "Hell"
        case .dark: "Dunkel"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
    init(storedValue: String) { self = Self(rawValue: storedValue) ?? .system }
}

enum FoldRouteColor {
    static let asphalt = Color(hex: 0x171A1C)
    static let signalYellow = Color(hex: 0xFFD43B)
    static let routeCyan = Color(hex: 0x2EC5CE)
    static let transitViolet = Color(hex: 0x7667E8)
    static let cloud = Color(hex: 0xF5F6F3)
    static let alertCoral = Color(hex: 0xE94F45)
    static let muted = Color(hex: 0x697077)
    static let panel = Color(light: 0xFFFFFF, dark: 0x171A1C)
    static let panelText = Color(light: 0x171A1C, dark: 0xF5F6F3)
    static let panelMuted = Color(light: 0x596469, dark: 0xB8C2C7)
    static let panelLine = Color(light: 0x7B878B, dark: 0x768386)
    static let panelSubtle = Color(light: 0xF0F3F1, dark: 0x202729)
    static let accent = Color(light: 0x755700, dark: 0xFFD43B)
    static let cyanText = Color(light: 0x086C74, dark: 0x2EC5CE)
    static let violetText = Color(light: 0x5B4BC4, dark: 0xB1A7FF)
    static let greenText = Color(light: 0x146C50, dark: 0x6EE7B7)
    static let alertText = Color(light: 0xB42332, dark: 0xFFB4AB)
}

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }

    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

struct CockpitPanel: ViewModifier {
    var padding: CGFloat = 18

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(FoldRouteColor.panel, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .foregroundStyle(FoldRouteColor.panelText)
            .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }
}

extension View {
    func cockpitPanel(padding: CGFloat = 18) -> some View {
        modifier(CockpitPanel(padding: padding))
    }
}

extension JourneyLegKind {
    var textColor: Color {
        switch self {
        case .approach, .bike: FoldRouteColor.cyanText
        case .fold, .unfold, .stop, .wait: FoldRouteColor.accent
        case .walk: FoldRouteColor.greenText
        case .transit: FoldRouteColor.violetText
        }
    }

    var color: Color {
        switch self {
        case .approach, .bike: FoldRouteColor.routeCyan
        case .fold, .unfold: FoldRouteColor.signalYellow
        case .walk: .mint
        case .transit: FoldRouteColor.transitViolet
        case .stop, .wait: FoldRouteColor.signalYellow
        }
    }

    var symbol: String {
        switch self {
        case .approach: "location.north.line.fill"
        case .bike: "bicycle"
        case .fold: "arrow.down.right.and.arrow.up.left"
        case .walk: "figure.walk"
        case .transit: "tram.fill"
        case .unfold: "arrow.up.left.and.arrow.down.right"
        case .wait: "clock.fill"
        case .stop: "mappin.circle.fill"
        }
    }
}
