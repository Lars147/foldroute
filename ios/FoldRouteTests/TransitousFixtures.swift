import Foundation

enum TransitousFixtures {
    static let empty = Data(#"{"itineraries":[],"direct":[]}"#.utf8)

    static let multimodal = normalized(Data(
        #"""
        {
          "itineraries": [
            {
              "id": "multimodal-1",
              "startTime": "2026-09-04T08:03:00Z",
              "endTime": "2026-09-04T08:50:00Z",
              "duration": 2820,
              "transfers": 0,
              "legs": [
                {
                  "mode": "BIKE",
                  "from": {"name":"START","lat":48.1320,"lon":11.5756},
                  "to": {"name":"Marienplatz","lat":48.1370,"lon":11.5754},
                  "startTime": "2026-09-04T08:03:00Z",
                  "endTime": "2026-09-04T08:10:00Z",
                  "distance": 1250,
                  "legGeometry": {"points":"_p~iF~ps|U_ulLnnqC_mqNvxq`@","precision":5},
                  "steps": [
                    {
                      "relativeDirection":"DEPART",
                      "distance":1250,
                      "polyline":{"points":"_p~iF~ps|U_ulLnnqC_mqNvxq`@","precision":5},
                      "streetName":"Tal"
                    }
                  ]
                },
                {
                  "mode": "SUBWAY",
                  "from": {"name":"Marienplatz","lat":48.1370,"lon":11.5754,"track":"2"},
                  "to": {"name":"Münchner Freiheit","lat":48.1614,"lon":11.5862,"scheduledTrack":"1"},
                  "startTime": "2026-09-04T08:15:00Z",
                  "endTime": "2026-09-04T08:35:00Z",
                  "routeShortName":"U6",
                  "headsign":"Garching-Forschungszentrum",
                  "agencyName":"MVG",
                  "realTime":true,
                  "cancelled":false
                },
                {
                  "mode": "BIKE",
                  "from": {"name":"Münchner Freiheit","lat":48.1614,"lon":11.5862},
                  "to": {"name":"END","lat":48.1750,"lon":11.6000},
                  "startTime": "2026-09-04T08:40:00Z",
                  "endTime": "2026-09-04T08:50:00Z",
                  "distance": 2100
                }
              ]
            }
          ],
          "direct": []
        }
        """#.utf8
    ))

    static let delfiPlatformCodes = Data(
        #"""
        {
          "itineraries": [
            {
              "id": "delfi-platform-1",
              "startTime": "2026-09-04T08:15:00Z",
              "endTime": "2026-09-04T08:40:00Z",
              "duration": 1500,
              "transfers": 1,
              "legs": [
                {
                  "mode": "SUBURBAN",
                  "from": {"name":"München Pasing","lat":48.1496,"lon":11.4618,"stopId":"de:09162:10:45:85","track":"85"},
                  "to": {"name":"München Ost","lat":48.1267,"lon":11.6042,"stopId":"de-DELFI_de:09162:910:41:82","track":"82"},
                  "startTime": "2026-09-04T08:15:00Z",
                  "endTime": "2026-09-04T08:28:00Z",
                  "routeShortName":"S4",
                  "headsign":"München Ost",
                  "agencyName":"S-Bahn München",
                  "realTime":true,
                  "cancelled":false
                },
                {
                  "mode": "SUBURBAN",
                  "from": {"name":"München Ost","lat":48.1267,"lon":11.6042,"stopId":"de:09162:10:1:1","track":"81"},
                  "to": {"name":"München Trudering","lat":48.1231,"lon":11.6472,"track":"3"},
                  "startTime": "2026-09-04T08:30:00Z",
                  "endTime": "2026-09-04T08:40:00Z",
                  "routeShortName":"S4",
                  "headsign":"Trudering",
                  "agencyName":"S-Bahn München",
                  "realTime":true,
                  "cancelled":false
                }
              ]
            }
          ],
          "direct": []
        }
        """#.utf8
    )

    static let directBike = normalized(Data(
        #"""
        {
          "itineraries": [],
          "direct": [
            {
              "id": "bike-1",
              "startTime": "2026-09-04T08:00:00Z",
              "endTime": "2026-09-04T08:32:00Z",
              "duration": 1920,
              "transfers": 0,
              "legs": [
                {
                  "mode":"BIKE",
                  "from":{"name":"START","lat":48.1320,"lon":11.5756},
                  "to":{"name":"END","lat":48.1750,"lon":11.6000},
                  "startTime":"2026-09-04T08:00:00Z",
                  "endTime":"2026-09-04T08:32:00Z",
                  "distance":6800,
                  "steps":[
                    {
                      "relativeDirection":"CONTINUE",
                      "distance":100,
                      "polyline":{"points":"_p~iF~ps|U_ulLnnqC_mqNvxq`@","precision":5},
                      "streetName":"Isarradweg"
                    },
                    {
                      "relativeDirection":"CONTINUE",
                      "distance":200,
                      "polyline":{"points":"_p~iF~ps|U","precision":5},
                      "streetName":"Isarradweg"
                    }
                  ]
                }
              ]
            }
          ]
        }
        """#.utf8
    ))
    /// Fixtures use matching street endpoints rather than unrelated polyline decoder examples.
    private static func normalized(_ data: Data) -> Data {
        var root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        for key in ["itineraries", "direct"] {
            var journeys = root[key] as! [[String: Any]]
            for i in journeys.indices {
                var legs = journeys[i]["legs"] as! [[String: Any]]
                for k in legs.indices where ["BIKE", "WALK"].contains(legs[k]["mode"] as! String) {
                    let from = legs[k]["from"] as! [String: Any]
                    let to = legs[k]["to"] as! [String: Any]
                    let a = (from["lat"] as! Double, from["lon"] as! Double)
                    let b = (to["lat"] as! Double, to["lon"] as! Double)
                    legs[k]["legGeometry"] = ["points": encode([a, b]), "precision": 5]
                    if var steps = legs[k]["steps"] as? [[String: Any]] {
                        func point(_ index: Int) -> (Double, Double) {
                            let fraction = Double(index) / Double(steps.count)
                            return (a.0 + (b.0 - a.0) * fraction, a.1 + (b.1 - a.1) * fraction)
                        }
                        for n in steps.indices {
                            steps[n]["polyline"] = ["points": encode([point(n), point(n + 1)]), "precision": 5]
                        }
                        legs[k]["steps"] = steps
                    }
                }
                journeys[i]["legs"] = legs
            }
            root[key] = journeys
        }
        return try! JSONSerialization.data(withJSONObject: root)
    }

    static func encode(_ points: [(Double, Double)]) -> String {
        var result = ""
        var previous = [0, 0]
        for point in points {
            for (axis, value) in [point.0, point.1].enumerated() {
                let current = Int((value * 100_000).rounded())
                let delta = current - previous[axis]
                previous[axis] = current
                var encoded = delta < 0 ? ~(delta << 1) : delta << 1
                while encoded >= 32 {
                    result.append(Character(UnicodeScalar(((encoded & 31) | 32) + 63)!))
                    encoded >>= 5
                }
                result.append(Character(UnicodeScalar(encoded + 63)!))
            }
        }
        return result
    }
    // Anonymized 36 m station walk, preserving the zero-distance elevator and surrounding geometry.
    static let elevatorWalk = Data(#"""
    {
      "itineraries": [
        {
          "id": "elevator-walk",
          "startTime": "2026-09-07T15:33:00Z",
          "endTime": "2026-09-07T15:39:00Z",
          "duration": 360,
          "transfers": 0,
          "legs": [
            {
              "mode": "WALK",
              "distance": 36.0,
              "startTime": "2026-09-07T15:33:00Z",
              "endTime": "2026-09-07T15:39:00Z",
              "from": {
                "name": "Testhaltestelle",
                "lat": 48.132,
                "lon": 11.576
              },
              "to": {
                "name": "Testhaltestelle",
                "lat": 48.13210699999999,
                "lon": 11.576144
              },
              "legGeometry": {
                "points": "ywvxzAgjpaUbAyF??cB}@??N{@??GZCLUMs@_@[Q_@Q??WM??}@vB",
                "precision": 6
              },
              "steps": [
                {
                  "relativeDirection": "CONTINUE",
                  "distance": 12.0,
                  "polyline": {
                    "points": "ywvxzAgjpaUbAyF",
                    "precision": 6
                  },
                  "streetName": ""
                },
                {
                  "relativeDirection": "CONTINUE",
                  "distance": 6.0,
                  "polyline": {
                    "points": "uuvxzAarpaUcB}@",
                    "precision": 6
                  },
                  "streetName": ""
                },
                {
                  "relativeDirection": "CONTINUE",
                  "distance": 2.0,
                  "polyline": {
                    "points": "yxvxzA_tpaUN{@",
                    "precision": 6
                  },
                  "streetName": ""
                },
                {
                  "relativeDirection": "ELEVATOR",
                  "distance": 0.0,
                  "polyline": {
                    "points": "",
                    "precision": 6
                  },
                  "streetName": ""
                },
                {
                  "relativeDirection": "CONTINUE",
                  "distance": 10.0,
                  "polyline": {
                    "points": "ixvxzA{upaUGZCLUMs@_@[Q_@Q",
                    "precision": 6
                  },
                  "streetName": ""
                },
                {
                  "relativeDirection": "CONTINUE",
                  "distance": 1.0,
                  "polyline": {
                    "points": "{|vxzAcwpaUWM",
                    "precision": 6
                  },
                  "streetName": ""
                },
                {
                  "relativeDirection": "CONTINUE",
                  "distance": 5.0,
                  "polyline": {
                    "points": "s}vxzAqwpaU}@vB",
                    "precision": 6
                  },
                  "streetName": ""
                }
              ]
            }
          ]
        }
      ],
      "direct": []
    }
    """#.utf8)
}
