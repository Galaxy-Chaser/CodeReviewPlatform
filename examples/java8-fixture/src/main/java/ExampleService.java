import java.util.List;

// This intentionally faulty fixture verifies local rules; it is not a Java 8 build example.
public class ExampleService {
    /** Demonstrates the known issues that the local scanner should identify. */
    public void run() {
        // TODO replace this debug output
        System.out.println("example");
        List<String> items = List.of("not compatible with Java 8");
        try { throw new IllegalStateException(); } catch (Exception ignored) { /* swallowed */ }
    }
}
