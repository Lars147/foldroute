import SwiftUI

enum FoldRouteColor {
    static let asphalt = Color(hex: 0x171A1C)
    static let signalYellow = Color(hex: 0xFFD43B)
    static let routeCyan = Color(hex: 0x2EC5CE)
    static let transitViolet = Color(hex: 0x7667E8)
    static let cloud = Color(hex: 0xF5F6F3)
    static let alertCoral = Color(hex: 0xE94F45)
    static let muted = Color(hex: 0x697077)
}

extension Color {
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
            .background(FoldRouteColor.asphalt.opacity(0.96), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }
}

extension View {
    func cockpitPanel(padding: CGFloat = 18) -> some View {
        modifier(CockpitPanel(padding: padding))
    }
}

extension JourneyLegKind {
    var color: Color {
        switch self {
        case .approach, .bike: FoldRouteColor.routeCyan
        case .fold, .unfold: FoldRouteColor.signalYellow
        case .walk: .mint
        case .transit: FoldRouteColor.transitViolet
        case .wait: FoldRouteColor.signalYellow
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
        }
    }
}
