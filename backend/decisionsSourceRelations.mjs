// Source-only model declarations. They express reading dependencies, never question relevance.
// Each edge is bound to its exact canonical source, body ranges and body hashes.
export const DECISIONS_SOURCE_RELATIONS = [
  {
    "type": "coread",
    "sourceId": "ocg-rule:c03/诱发类效果",
    "canonicalSha256": "3576bba4a0d7fead3a184738f510fc3df32955df034d29234f36a87ad04e7508",
    "left": {
      "range": [
        22155,
        22200
      ],
      "textSha256": "8f4a2ae2eb67c985412b07db228364d13daa3c747e1c262fa372666556f960f2"
    },
    "right": {
      "range": [
        22203,
        24406
      ],
      "textSha256": "188f7662d468c66bbd6c4118692407bd3cb0c1f7a859ee786f6e1dd93dc2c1c8"
    },
    "phase": "coread"
  },
  {
    "type": "coread",
    "sourceId": "ocg-rule:c03/诱发类效果",
    "canonicalSha256": "3576bba4a0d7fead3a184738f510fc3df32955df034d29234f36a87ad04e7508",
    "left": {
      "range": [
        24427,
        24517
      ],
      "textSha256": "088182a6d340f6455471097da9f0851c899eb5d044dec711ffd7e209999a1bd1"
    },
    "right": {
      "range": [
        24520,
        24687
      ],
      "textSha256": "851918df240016abbe68a8ab81514003d531d528212b37a62ea564accbc19985"
    },
    "phase": "coread"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:81",
      "range": [
        37611,
        37724
      ],
      "textSha256": "53d645118ec61773a65d13d6f317eec30c380e8cc7ad7996de4014bff7fe3d75"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:70",
      "range": [
        32176,
        32295
      ],
      "textSha256": "9763bb33c448fbbf8ec9d9675dfb13aa87f298adc601763230ae63fb0fd4d199"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:82",
      "range": [
        37730,
        38312
      ],
      "textSha256": "9ec623ba3cd20cf06ea776bca89711666a95ba7c1446d74495b4f761df5b5cc3"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:81",
      "range": [
        37611,
        37724
      ],
      "textSha256": "53d645118ec61773a65d13d6f317eec30c380e8cc7ad7996de4014bff7fe3d75"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:82",
      "range": [
        37730,
        38312
      ],
      "textSha256": "9ec623ba3cd20cf06ea776bca89711666a95ba7c1446d74495b4f761df5b5cc3"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:70",
      "range": [
        32176,
        32295
      ],
      "textSha256": "9763bb33c448fbbf8ec9d9675dfb13aa87f298adc601763230ae63fb0fd4d199"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:83",
      "range": [
        38318,
        38658
      ],
      "textSha256": "26838181413c0c4cf261165972004be681d5ce85facdf57a0264ef11fab0d11c"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:81",
      "range": [
        37611,
        37724
      ],
      "textSha256": "53d645118ec61773a65d13d6f317eec30c380e8cc7ad7996de4014bff7fe3d75"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:83",
      "range": [
        38318,
        38658
      ],
      "textSha256": "26838181413c0c4cf261165972004be681d5ce85facdf57a0264ef11fab0d11c"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:70",
      "range": [
        32176,
        32295
      ],
      "textSha256": "9763bb33c448fbbf8ec9d9675dfb13aa87f298adc601763230ae63fb0fd4d199"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:96",
      "range": [
        43605,
        44085
      ],
      "textSha256": "3dbb23c2ac6919e58961dd7355f47baaeb97a62494e9c0cc105e174fc61402c6"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:94",
      "range": [
        43459,
        43515
      ],
      "textSha256": "b7f67951c0317c3832eae4211dff091db9ed1053424cea1a459d07132659a020"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:97",
      "range": [
        44085,
        45011
      ],
      "textSha256": "7550bab94fdd1ba78cbdcddcdacfaf414dbb1c4ef8fac23a59e71cd7499ed76b"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:94",
      "range": [
        43459,
        43515
      ],
      "textSha256": "b7f67951c0317c3832eae4211dff091db9ed1053424cea1a459d07132659a020"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:98",
      "range": [
        45024,
        45124
      ],
      "textSha256": "a1082df06ffe6baaaf4c98118ae56d7615fc887ce77ce626059b270ada0105e6"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:94",
      "range": [
        43459,
        43515
      ],
      "textSha256": "b7f67951c0317c3832eae4211dff091db9ed1053424cea1a459d07132659a020"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:99",
      "range": [
        45124,
        45210
      ],
      "textSha256": "fc645ebcbd3d5e30a49f71242a863d4b2dbd45a68ce16bb7bd25ee1f803824fb"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:94",
      "range": [
        43459,
        43515
      ],
      "textSha256": "b7f67951c0317c3832eae4211dff091db9ed1053424cea1a459d07132659a020"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:100",
      "range": [
        45224,
        45555
      ],
      "textSha256": "17a016b03e80179c14569cdbb08d057322ba804207ae1f97ac1dfd2e9ac2cabe"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:94",
      "range": [
        43459,
        43515
      ],
      "textSha256": "b7f67951c0317c3832eae4211dff091db9ed1053424cea1a459d07132659a020"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:102",
      "range": [
        45907,
        46766
      ],
      "textSha256": "8ae22a46bca690bafd8c64d0b1f3665f15344491dc62e022750761dca486235f"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:95",
      "range": [
        43515,
        43596
      ],
      "textSha256": "3306f4023e44a2835c35593331a8f8d9151a053887a5c9084aafa0b895012716"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c03/特定效果的处理方法",
    "canonicalSha256": "654e2228931d2fdc5c0eb8593b1025686b6be105cd4a5c278663252f6e92a68b",
    "left": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:103",
      "range": [
        46766,
        48850
      ],
      "textSha256": "7f986070a9667ca787bd0ff1675645aae58bbb6b444f0b22a0445d3675dc955b"
    },
    "right": {
      "id": "ocg-rule:c03/特定效果的处理方法:atom:95",
      "range": [
        43515,
        43596
      ],
      "textSha256": "3306f4023e44a2835c35593331a8f8d9151a053887a5c9084aafa0b895012716"
    },
    "phase": "ancestor"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制",
    "canonicalSha256": "1b5212f23284bf6cf484adb789dd418ab7139b43f253a9ebc921a850c3f73dd4",
    "left": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:14",
      "range": [
        2667,
        2840
      ],
      "textSha256": "25066c9944d3229248e7f234d5e6a95535446cdb970c948db005817cdd462b07"
    },
    "right": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:13",
      "range": [
        2593,
        2664
      ],
      "textSha256": "482a97d247c37b9c9ecbbbd97417b373369ce0a859455899ab2e92c7cea5f8f8"
    },
    "phase": "required"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制",
    "canonicalSha256": "1b5212f23284bf6cf484adb789dd418ab7139b43f253a9ebc921a850c3f73dd4",
    "left": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:20",
      "range": [
        3908,
        4205
      ],
      "textSha256": "c08b15f11056ac920458bbf43c4f62c2ec7ddb5138028f8c1e0ba843e698e504"
    },
    "right": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:18",
      "range": [
        3766,
        3903
      ],
      "textSha256": "ff176c4ceede66e112e3d60edc42a1d9eeb23ae5bec66432f7f05064d7e22f26"
    },
    "phase": "required"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制",
    "canonicalSha256": "1b5212f23284bf6cf484adb789dd418ab7139b43f253a9ebc921a850c3f73dd4",
    "left": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:26",
      "range": [
        5027,
        5947
      ],
      "textSha256": "626f69ba000d42ba4ff324b859cc4fe6ed21c40715e9607ff5233f2f6dad39df"
    },
    "right": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:25",
      "range": [
        4874,
        5027
      ],
      "textSha256": "a186031d6ca748c0397de22788cad76b51cd10861ced5aca3b15b8e892248f7a"
    },
    "phase": "required"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制",
    "canonicalSha256": "1b5212f23284bf6cf484adb789dd418ab7139b43f253a9ebc921a850c3f73dd4",
    "left": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:30",
      "range": [
        6881,
        7023
      ],
      "textSha256": "af110df3b84910ba040853242c99a8088917792a042906f9ebe53012c6af8663"
    },
    "right": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:29",
      "range": [
        6826,
        6881
      ],
      "textSha256": "0a0c37a11e346eb96f329f5d5343227bbbb8f512261e51f7809de0d8896cfb20"
    },
    "phase": "required"
  },
  {
    "type": "required",
    "sourceId": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制",
    "canonicalSha256": "1b5212f23284bf6cf484adb789dd418ab7139b43f253a9ebc921a850c3f73dd4",
    "left": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:32",
      "range": [
        7028,
        7178
      ],
      "textSha256": "af41cafd3b473086fe3ee8eeb28de0c64a9bbfad249fb282eb2a496d6148b5a2"
    },
    "right": {
      "id": "ocg-rule:c02/特殊召唤怪兽、召唤限制和苏生限制:atom:30",
      "range": [
        6881,
        7023
      ],
      "textSha256": "af110df3b84910ba040853242c99a8088917792a042906f9ebe53012c6af8663"
    },
    "phase": "required"
  }
];
