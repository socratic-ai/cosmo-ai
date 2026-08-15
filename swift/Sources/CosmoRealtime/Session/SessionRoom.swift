import LiveKit

/// The ``Room`` every session joins. Signaling state resolved ahead of a
/// connect lives on the `Room` itself, so a room built in advance and one
/// built at connect must be configured identically — hence the single
/// factory.
func makeSessionRoom() -> Room {
    Room(roomOptions: RoomOptions(
        defaultAudioCaptureOptions: RealtimeSession.audioCaptureOptions,
        adaptiveStream: true,
        dynacast: true
    ))
}
