import Testing

import CosmoRealtime

@Suite struct FaceGeometryTests {
    @Test("distanceMeters defaults to nil")
    func distanceDefaultsToNil() {
        #expect(FaceGeometry().distanceMeters == nil)
    }

    @Test("distanceMeters is carried through the initializer")
    func distanceMetersIsCarried() {
        #expect(FaceGeometry(distanceMeters: 0.42).distanceMeters == 0.42)
    }

    @Test("a geometry carrying only distanceMeters is not empty")
    func distanceMetersMakesNonEmpty() {
        #expect(FaceGeometry(distanceMeters: 0.42).isEmpty == false)
    }

    @Test("a geometry with no contours, regions, pose, or distance is empty")
    func fullyEmptyIsEmpty() {
        #expect(FaceGeometry().isEmpty == true)
    }
}
