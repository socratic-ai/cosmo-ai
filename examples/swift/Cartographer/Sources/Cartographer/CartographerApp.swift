import SwiftUI

@main
struct CartographerApp: App {
    var body: some Scene {
        WindowGroup("Cartographer") {
            ContentView()
                .frame(minWidth: 1120, minHeight: 720)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1240, height: 800)
    }
}
