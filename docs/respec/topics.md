# Topics

## Adoption topic #1: Implement and validate an OGC API Processes service

### Goal 

Make an existing calculation module work according to the nLDT reference architecture (https://github.com/Geonovum/NLDT-Architectuur) and have it interoperate with software from other software vendors. 

### Description 

Add a full implementation of the OGC API Processes specification to an existing calculation module. With “full” implementation we mean supporting process input & output descriptions, both Sync and Async execution mode, and job management. The implementation must pass the OGC compliance check and pass Geonovum’s OGC-checker with no faults. 

### Deliverables 

- A written report of the findings encountered during implementation. Geonovum will provide a Github repository where the report can be added in markdown format. We will act as editors and consolidate all reports into one Respec/HTML document.  
- The software component developed under this contract must be made available in the standard market offering, at no additional cost. 
- A demo service (with demo data) should be kept available for the public at least until 6 months after the testbed ends. 
- Short demo video’s 

### Requirements / standards / Open-Source software 

- Mandatory Standards: https://ogcapi.ogc.org/processes/ 

    OGC API Processes v1.0 is the approved version of the API, and v2.0 is a stable draft. We want to encourage using version 2 of the specification. 

- Optional available Open-Source Software (for inspiration and as example code for testing): 

    For OGC API Processes open source client and server implementations are listed in the OGC Github repository: https://github.com/opengeospatial/ogcapi-processes/blob/master/implementations.adoc 

  
    The above software is listed for convenience; there may be more available.  

## Adoption topic #2: Complete and validate an existing OGC API Processes service

### Goal 

Complete an existing API Processes implementation, make it function within the nLDT ecosystem and have it interoperate with software from other software vendors. 

### Description 

Complete an existing implementation of the OGC API Process specification to a full implementation on top of an existing calculation module. With “full” implementation we mean supporting process input & output descriptions, both Sync and Async execution mode and job management. The implementation must pass the OGC compliance check and pass Geonovum’s OGC-checker with no faults. 

### Deliverables 

- A written report of the findings encountered during implementation. Geonovum will provide a Github repository where the report can be added in markdown format. We will act as editors and consolidate all reports into one Respec/HTML document.  
- The software component developed under this contract must be made available in the standard market offering, at no additional cost. 
- A demo service (with demo data) should be kept available for the public at least until 6 months after the testbed ends. 
- Component is ready to do taken up in an AppStore 
- Short demo video’s 

### Requirements / standards / Open-Source Software 

- Mandatory Standards: https://ogcapi.ogc.org/processes/ 

    OGC API Processes v1.0 is the approved version of the API, and v2.0 is a stable draft. We want to encourage the use of version 2 of the specification. 

- Optional available Open Source Software (for inspiration and as example code for testing): 

    For OGC API Processes open source client and server implementations are listed in the OGC Github repository: https://github.com/opengeospatial/ogcapi-processes/blob/master/implementations.adoc 

  The above software is listed for convenience; there may be more available.  

## Adoption topic #3: Implement and validate OGC API Processes client

### Goal 

Implement an OGC API Processes client, make it function within the nLDT ecosystem and have it interoperate with software from other software vendors. 

### Description 

Create a full implementation of an OGC API Process specification client in your visualization software. With “full” implementation we mean supporting process input & output descriptions, both Sync and Async execution mode, and job management. 

### Deliverables 

- A written report of the findings encountered during implementation. Geonovum will provide a Github repository where the report can be added in markdown format. We will act as editors and consolidate all reports into one Respec/HTML document.  
- The software component developed under this contract must be made available in the standard market offering, at no additional cost. 
- A demo client-side service should be kept available for the public at least until 6 months after the testbed ends. 
- Component is ready to do taken up in an AppStore 
- Short demo video’s 

### Requirements / standards / Open-Source Software 

- Mandatory Standards: https://ogcapi.ogc.org/processes/ 

    OGC API Processes v1.0 is the approved version of the API, and v2.0 is a stable draft. We want to encourage the use of version 2 of the specification. 

- Optional available Open-Source Software (for inspiration and as example code for testing): 

    For OGC API Processes open-source client and server implementations are listed in the OGC Github repository: https://github.com/opengeospatial/ogcapi-processes/blob/master/implementations.adoc 

  The above software is listed for convenience; there may be more available.  

## Research topic #4: App-Store / Recipes

### Goal 

Offer ready-made solutions for real-world problems, expressed as a ‘recipe’: a combination of data-sources (ingredients) and operations in the form of an ordered list of processes (like cooking instructions).

### Description 

We are familiar with the App Store (and Play Store) from our mobile phones (smartphones, smart devices): here we find all kinds of applications ('Apps', applications) that, after installation, work immediately and are integrated with the smartphone ecosystem. 

The Windows and macOS operating systems also have an App Store – where apps are promoted but also organized into categories to make searching easier. Just like on smart devices, installation is flawless and the application works seamlessly within the operating system's ecosystem. 

Payment is easily arranged in both the App Stores of smart devices and those of Windows or macOS – digital payments can be made via all kinds of payment methods. 

App settings are stored in the operating system; when the app is used on another device by the same user, it is immediately recognizable.  

Digital Twins also operate within their own ecosystem (and together form an ecosystem). Digital Twins are defined using computational modules and an App Store in the context of Digital Twins, it should offer easy-to-install-and-use computational modules. 

Whereas the App Store in smart devices uses the native functions of Windows or macOS, the App Store in Digital Twins uses HTTP as the primary means of communication. 

#### Recipes 

Recipes can be expressed in various ways. OGC API Processes part 2 https://docs.ogc.org/DRAFTS/20-044.html. Common Workflow Language (CWL), a standard that specifies the document schema and execution semantics for composing workflows from components such as command line tools and other workflows. This could be a way to describe recipes. Another proposal for recipe description was created within nLDT. This proposal is not yet standardized and could be used as a basis or inspiration source for experimental implementation. (see appendix B for link to the experimental implementation) A third option for describing recipes is Arazzo, a community-driven open specification within the OpenAPI Initiative. (https://www.openapis.org/arazzo-specification)

#### Catalogs 

A catalog serves as a central hub where datasets and services are collected, documented, and made accessible. It offers a clear structure in which information is described via metadata, such as title, subjects, origin, and format. This allows users to quickly discover what data is available and how to utilize it, without having to search through separate documents or scattered sources. 

In addition to organizing data, a catalog offers functions for searching, filtering, and comparing services. Users can filter using search terms, categories, or tags to find exactly what is relevant to their application. The system often supports multiple types of services—from open data to internal administrative records—and can process various data types and files, such as tables, geographic data, or API connections. 

An important aspect of such a catalog system is the focus on accessibility and reusability. Through standardization, clear documentation, and reliable connections, it becomes easy to integrate data into analyses, applications, or visualizations. Moreover, the platform encourages collaboration between departments, organizations, or developers by making datasets findable and understandable, which contributes to transparency and innovation. 

#### Metadata 

Metadata consists of descriptive data that helps to find, understand, and correctly interpret datasets and services. They include information about the content, origin, structure, and quality of the data, among other things. By capturing this context, it becomes clear to users exactly what a dataset contains, how current or reliable it is, and in which situations it is suitable for use. In this way, metadata acts as a kind of user manual for data. 

Standards are often used to record metadata in a structured and interchangeable manner. A widely used standard is DCAT, a vocabulary developed to describe services. DCAT defines uniform terms and relationships, making services easier to publish, search, and link between different platforms. Through this standardization, organizations can keep their data descriptions consistent and promote interoperability. 

In addition to improving findability and consistency, metadata also contributes to transparency and governance. They clarify who is responsible for a dataset, which license applies, how it is updated, and what restrictions apply. As a result, users can better assess whether the data is suitable for their purposes, and organizations maintain an overview of their own information management. 

#### Recipe metadata 

DCAT is a mature and widely used standard, and the Netherlands has a standardized DCAT profile: DCAT-AP-NL. However, DCAT-AP-NL is designed to describe datasets and services. It does not currently support metadata for recipes: combinations of data sources and operations that together produce a result.  

For users to find recipes in a catalog, they must be described using metadata, just like datasets and services. How to capture recipe metadata in DCAT-AP-NL is not yet fully defined. 

There are standards extending DCAT to describe properties like Recipes. We are investigating DPROD (Data Product Ontology (DPROD)) and APKG (GitHub - ILIAD-ocean-twin/APKG: Application Package Application Profile · GitHub).

### Deliverables 

- A written report; Geonovum will provide a Github repository where the report can be added in markdown format. We will act as editors and consolidate all reports into one Respec/HTML document.  
- If any software component is developed, we prefer the code to be made available in an open-source repository and pull requests to existing OS projects in case these are used.  
- The solution should be kept available for the public at least until 6 months after the testbed ends.  
- Results are input for an AppStore 
- Short demo video’s 
    - A viewer can find the Metadata, bind the recipe and execute the recipe – the results are visualized in the viewer. 

### Requirements / standards / Open-Source Software 

- Mandatory Standards: 
    - OGC API Processes 
    - OGC API Records 
    - DCAT-AP-NL 

 More on orchestration to be found as a deliverable from Testbed2 (https://github.com/Geonovum/DTaaS-Testbed2/blob/main/deliverables/DTaas2_Orchestration-Avineon_Tensing.pdf). 

OGC API Processes v1.0 is the approved version of the API, and v2.0 is a stable draft. We want to encourage the use of version 2 of the specification. 

- Proposed Standards: 
    - CWL (https://www.commonwl.org) 
    - Arazzo (https://www.openapis.org/arazzo-specification) 
    - Roll-your own (https://github.com/Geonovum/nLDT-Recipe) 

NOTE: We intend to award multiple participants for this research topic. Our aim is to have at least one of each for these Recommended Standards.

## Research topic #5: Web 3D Context document (export/import)

### Goal 

The nLDT ecosystem knows a lot of visualization components, each having their own strengths and specific capabilities (including AR/VR). The goal of this research topic is the ability to export scene information from a visualization component and the ability to import that scene information in another visualization component. 

### Description 

The 3D Context Document states how a specific grouping of one or more maps from one or more map servers can be described in a portable, platform-independent format for storage in a repository or for transmission between clients. This description is known as a Web 3D Context Document,” or simply a “3d Context.” A 3D Context document includes information about the services(s) providing data in the overall view, the 3D viewpoint, time, bounding box and map projection shared by all the data, sufficient operational metadata for Client software to reproduce the 3D viewpoint, and ancillary metadata used to annotate or describe the maps and their provenance for the benefit of human viewers. A 3D Context document is structured using JSON.    

> The work should continue to build on the export-import-scenes: https://geonovum.github.io/DTaaS-Testbed2/#export-import-scenes-6-2-0. 

### Deliverables 

- A written report; Geonovum will provide a Github repository where the report can be added in markdown format. We will act as editors an consolidate all reports into one Respec/HTML document.  
- If any software component is developed, we prefer the code to be made available in an open source repository and pull requests to existing OS projects in case these are used.   
- The solution should be kept available for the public at least until 6 months after the testbed ends.  
- Short demo video’s 

### Requirements / standards / Open-Source Software 

- Mandatory documents: 
    https://github.com/Geonovum/DTaaS-Testbed2/blob/main/deliverables/Digital_Twin_as_a_Service%E2%80%93Testbed_II-Import_Export_Scenes.pdf (also to be found in the DTaaS-Testbed2 repository, under deliverables).  

    NOTE: We encourage submitting with multiple parties for this topic, each offering a visualization component for use with 3D Context Documents. 