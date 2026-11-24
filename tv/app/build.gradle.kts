plugins {
    id("com.android.application")
}

android {
    namespace = "com.nexttupp.tv"
    compileSdk = 36

    defaultConfig {
        // Permanent: Android ties updates (and, from 2027, developer verification) to this id and the signing key.
        applicationId = "com.nexttupp.tv"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
