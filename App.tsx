import { mount, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";

function App() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: 22 }}>Herdr Desktop</Text>
      <Text>{`core ${Herdr.coreVersion()}`}</Text>
    </View>
  );
}

mount(App);
